/**
 * Tribe database — schema, migrations, indexes, prepared statements.
 */

import { Database } from "bun:sqlite"
import { TRIBE_ACTIONABLE_TYPES, TRIBE_AUTO_TRACK_TYPES } from "../../../wire/src/command-descriptors.ts"

// ---------------------------------------------------------------------------
// Schema & migrations
// ---------------------------------------------------------------------------

export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA busy_timeout = 5000")

  db.run(`CREATE TABLE IF NOT EXISTS sessions (
		id         TEXT PRIMARY KEY,
		name       TEXT NOT NULL UNIQUE,
		role       TEXT NOT NULL,
		domains    TEXT NOT NULL DEFAULT '[]',
		pid        INTEGER NOT NULL,
		cwd        TEXT,
		project_id TEXT,
		claude_session_id TEXT,
		claude_session_name TEXT,
		identity_token TEXT,
		mailbox_authority_hash TEXT,
		launch_id TEXT,
		launch_parent_pid INTEGER,
		started_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		last_delivered_ts INTEGER,
		last_delivered_seq INTEGER NOT NULL DEFAULT 0,
		last_inbox_pull_seq INTEGER NOT NULL DEFAULT 0,
		filter_mode  TEXT NOT NULL DEFAULT 'normal',
		filter_until INTEGER,
		filter_mute TEXT,
		delivery     TEXT NOT NULL DEFAULT 'push',
		account    TEXT,
		provider   TEXT
	)`)

  // Migrations table — tracks schema version so we can evolve the DB without
  // relying on try/catch soup. Each row in MIGRATIONS is run exactly once,
  // in order, for databases whose version < migration.version. Fresh installs
  // skip all migrations because the CREATE TABLE statements above already
  // reflect the latest schema.
  db.run("CREATE TABLE IF NOT EXISTS _schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  const versionRow = db.prepare("SELECT value FROM _schema_meta WHERE key = 'version'").get() as {
    value: string
  } | null
  const currentVersion = versionRow ? Number(versionRow.value) : 0

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue
    migration.up(db)
  }
  const latestMigration = MIGRATIONS.at(-1)
  if (latestMigration !== undefined && latestMigration.version > currentVersion) {
    const latest = latestMigration.version
    db.run("INSERT INTO _schema_meta (key, value) VALUES ('version', $v) ON CONFLICT(key) DO UPDATE SET value = $v", {
      $v: String(latest),
    } as never)
  } else if (versionRow === null && latestMigration !== undefined) {
    // Fresh install — stamp the current version so future migrations start from here.
    const latest = latestMigration.version
    db.run("INSERT OR IGNORE INTO _schema_meta (key, value) VALUES ('version', $v)", {
      $v: String(latest),
    } as never)
  }

  db.run(`CREATE TABLE IF NOT EXISTS messages (
		rowid      INTEGER PRIMARY KEY AUTOINCREMENT,
		id         TEXT NOT NULL UNIQUE,
		type       TEXT NOT NULL,
		sender     TEXT NOT NULL,
		recipient  TEXT NOT NULL,
		kind       TEXT NOT NULL DEFAULT 'direct',
		content    TEXT NOT NULL,
		bead_id    TEXT,
		ref        TEXT,
		ts         INTEGER NOT NULL,
		delivery   TEXT NOT NULL DEFAULT 'push',
		topic      TEXT,
		room_id    TEXT,
		request    TEXT,
		reply      TEXT,
		correlated_reply_requester TEXT,
		summary    TEXT,
		session_id TEXT,
		attention_required INTEGER NOT NULL DEFAULT 0
	)`)

  db.run(`CREATE TABLE IF NOT EXISTS messages_archive (
		seq         INTEGER NOT NULL,
		id          TEXT PRIMARY KEY,
		type        TEXT NOT NULL,
		sender      TEXT NOT NULL,
		recipient   TEXT NOT NULL,
		kind        TEXT NOT NULL DEFAULT 'direct',
		content     TEXT NOT NULL,
		bead_id     TEXT,
		ref         TEXT,
		ts          INTEGER NOT NULL,
		delivery    TEXT NOT NULL DEFAULT 'push',
		topic       TEXT,
		room_id     TEXT,
		archived_at INTEGER NOT NULL,
		request     TEXT,
		reply       TEXT,
		correlated_reply_requester TEXT,
		summary     TEXT,
		session_id  TEXT,
		attention_required INTEGER NOT NULL DEFAULT 0
	)`)

  // Ball-tracker: per-(request_id, recipient) row for every open request.
  // See @km/tribe/message-ball-tracker. Sender opens a tracked request by
  // sending a message with `request=<id>`; recipient closes it by replying
  // with the structured `reply` field (CLI: `--reply`). Multi-target
  // (`to: [...]`) and broadcast (`to: "*"`)
  // both produce one row per resolved recipient.
  db.run(`CREATE TABLE IF NOT EXISTS pending_request (
		request_id TEXT NOT NULL,
		recipient  TEXT NOT NULL,
		sender     TEXT NOT NULL,
		opened_at  INTEGER NOT NULL,
		expires_at INTEGER,
		message_id TEXT NOT NULL,
		fanout     TEXT NOT NULL DEFAULT 'first',
		request_kind TEXT NOT NULL DEFAULT 'request' CHECK (request_kind IN ('request', 'incident')),
		PRIMARY KEY (request_id, recipient)
	)`)

  // `cursors` and `reads` tables removed by migration v9 — the event-bus
  // (km-tribe.event-bus) made them vestigial: per-session delivery state now
  // lives on `sessions.last_delivered_seq`, and read-receipts were never
  // written by the post-event-bus code path. Fresh installs never create them.

  // 19442 undead reframe — durable per-RECIPIENT attention mailbox. One row
  // per mailbox name; `last_actionable_seq` is the highest durable-attention
  // rowid (direct request/query/verdict/assign/response) acknowledged for that
  // name. Keyed by recipient — NOT session — so rename/rejoin/takeover retain
  // the mailbox and recovery never needs to rewind a session's ambient cursor.
  db.run(`CREATE TABLE IF NOT EXISTS mailbox_cursors (
		recipient           TEXT PRIMARY KEY,
		last_actionable_seq INTEGER NOT NULL DEFAULT 0,
		updated_at          INTEGER NOT NULL,
		last_attention_read_at INTEGER
	)`)

  // 21454 — persisted runtime-rename authority. An explicit tribe.rename /
  // tribe.join writes the session's chosen name here keyed by launch identity;
  // registration re-applies it so a reconnect/daemon-restart re-register (which
  // carries the frozen spawn-time name) cannot silently revert the identity.
  db.run(`CREATE TABLE IF NOT EXISTS launch_renames (
		launch_id         TEXT NOT NULL,
		launch_parent_pid INTEGER NOT NULL,
		name              TEXT NOT NULL,
		renamed_at        INTEGER NOT NULL,
		PRIMARY KEY (launch_id, launch_parent_pid)
	)`)

  // 21576 S3 — daemon-authenticated provider turn-start receipts. Identity is
  // stamped from the registered connection; callers cannot self-assert the
  // launch/session columns. Provider turns are idempotent within one launch.
  db.run(`CREATE TABLE IF NOT EXISTS turn_start_receipts (
		receipt_seq          INTEGER PRIMARY KEY AUTOINCREMENT,
		session              TEXT NOT NULL,
		launch_id            TEXT NOT NULL,
		launch_parent_pid    INTEGER NOT NULL,
		controller_session_id TEXT NOT NULL,
		provider_session_id  TEXT NOT NULL,
		provider_turn_id     TEXT NOT NULL,
		started_at           INTEGER NOT NULL,
		received_at          INTEGER NOT NULL,
		UNIQUE (launch_id, launch_parent_pid, provider_session_id, provider_turn_id)
	)`)

  db.run(`CREATE TABLE IF NOT EXISTS retros (
		id          TEXT PRIMARY KEY,
		tribe_start INTEGER NOT NULL,
		tribe_end   INTEGER NOT NULL,
		members     TEXT NOT NULL,
		metrics     TEXT NOT NULL,
		lessons     TEXT NOT NULL,
		full_md     TEXT NOT NULL,
		ts          INTEGER NOT NULL
	)`)

  // Dedup table — atomic INSERT OR IGNORE prevents race-condition duplicates
  db.run(`CREATE TABLE IF NOT EXISTS dedup (
		key        TEXT PRIMARY KEY,
		session_id TEXT NOT NULL,
		ts         INTEGER NOT NULL
	)`)

  db.run(`CREATE TABLE IF NOT EXISTS coordination (
		project_id  TEXT NOT NULL,
		key         TEXT NOT NULL,
		value       TEXT,
		updated_by  TEXT,
		updated_at  INTEGER,
		PRIMARY KEY (project_id, key)
	)`)

  // Matrix-shape primitives (km-tribe.event-classification): rooms scope events
  // for future multi-room support; today every project has one synthetic room.
  db.run(`CREATE TABLE IF NOT EXISTS rooms (
		id           TEXT PRIMARY KEY,
		project_id   TEXT,
		name         TEXT,
		created_at   INTEGER NOT NULL,
		creator_id   TEXT,
		metadata     TEXT
	)`)
  db.run(`CREATE TABLE IF NOT EXISTS room_members (
		room_id     TEXT NOT NULL,
		session_id  TEXT NOT NULL,
		joined_at   INTEGER NOT NULL,
		role        TEXT NOT NULL DEFAULT 'member',
		PRIMARY KEY (room_id, session_id)
	)`)

  // `dismissals` table was dropped by migration v11 — ambient classification
  // + the inbox cursor already cover the audit / "ignored event" use case.

  // `event_log` was merged into `messages WHERE kind='event'` by migration v8
  // (km-tribe.polish-sweep item 9). Fresh installs get only the messages table;
  // existing databases retain their event_log rows via the v8 backfill.

  // Create indexes if they don't exist
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_recipient_ts ON messages(recipient, ts)")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender)")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_type_ts ON messages(type, ts)")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_kind_ts ON messages(kind, ts)")
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at)")
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_identity ON sessions(identity_token)")
  db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_mailbox_authority ON sessions(mailbox_authority_hash) WHERE mailbox_authority_hash IS NOT NULL",
  )
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_launch_identity ON sessions(name, launch_id, launch_parent_pid)")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts)")
  // Leading-column index on launch_id. idx_sessions_launch_identity leads with
  // `name`, so it cannot serve a launch_id predicate — managed-inbox routing
  // scanned the whole sessions table on every request.
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_launch_id ON sessions(launch_id)")
  // No index is added for countDurableSessionRows. Measured: its plan is
  // already "SCAN sessions USING COVERING INDEX idx_sessions_launch_identity",
  // and a COUNT still visits every matching entry, so no index makes it
  // sub-linear — a partial index was tried, was never chosen by the planner,
  // and would only have added write amplification to every registration. The
  // row count it walks is bounded by the disconnect-driven collection above
  // instead. See the wedge report for the numbers.
  db.run("CREATE INDEX IF NOT EXISTS idx_coordination_project ON coordination(project_id)")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_delivery_ts ON messages(delivery, ts)")
  db.run("DROP INDEX IF EXISTS idx_messages_plugin_kind_ts")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_topic_ts ON messages(topic, ts)")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_room_ts ON messages(room_id, ts)")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_archive_ts ON messages_archive(ts)")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_archive_seq ON messages_archive(seq)")
  db.run("CREATE INDEX IF NOT EXISTS idx_pending_recipient ON pending_request(recipient)")
  db.run("CREATE INDEX IF NOT EXISTS idx_pending_sender ON pending_request(sender)")
  // Journal retention's ball-tracker exclusion (retention.ts): before hard-
  // deleting a messages_archive row, the sweep checks whether any open
  // pending_request still points at it via message_id. Without a
  // message_id-leading index that NOT EXISTS probe is a full table scan of
  // pending_request per candidate row, once per sweep tick.
  db.run("CREATE INDEX IF NOT EXISTS idx_pending_message_id ON pending_request(message_id)")
  // The two indexes the attention projection needs. Every statement built on
  // `unretiredAttentionPredicateSql` reads the journal twice over — once to
  // find a seat's candidate messages, once per candidate to ask whether a
  // reply already retired it — and without these both halves degraded into
  // journal-wide scans. Measured on the live 105MB journal (105,167 messages,
  // @chief holding 31,345 of them): ONE inbox-wait for @chief cost 590,084
  // read syscalls, 2,059 MB of page reads and 326 ms of CPU, which held the
  // daemon at ~623,000 reads/second and two thirds of a core indefinitely.
  // Both drop to nil with these present. See attention-scan-bounded.test.ts,
  // which pins each growth term with its own probe.
  //
  // Retirement lookup. The predicate is a correlated NOT EXISTS keyed on
  // (sender, recipient, reply); the closest index was idx_messages_sender, so
  // each candidate row re-scanned everything its counterpart had ever sent —
  // the quadratic term, worst exactly on the busiest seat. Partial because
  // only reply-bearing directs can retire anything: 2,600 of 105,167 rows
  // live, so it costs almost nothing to carry and stays covering.
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_messages_reply_retire ON messages(sender, recipient, reply) WHERE kind = 'direct' AND reply IS NOT NULL",
  )
  // Outer drive. Without a recipient-leading index the planner chose
  // idx_messages_kind_ts and walked every direct message in the journal, then
  // sorted through a temp B-tree so `ORDER BY rowid DESC LIMIT 1` could not
  // short-circuit — a seat with no mail paid the same full walk as @chief.
  // Trailing rowid makes each seat's slice already rowid-ordered, so the walk
  // stops at the first hit. Deliberately NOT (recipient, kind, type): an
  // `IN`-list on the last column iterates per value, which reintroduces the
  // sort this exists to remove.
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_recipient_kind ON messages(recipient, kind)")
  // The archive half of the same retirement lookup. A reply that has already
  // been archived still retires its request, so the journal-sourced predicate
  // probes both tables; without this the archived half stayed a full scan and
  // simply moved the stall rather than removing it.
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_messages_archive_reply_retire ON messages_archive(sender, recipient, reply) WHERE kind = 'direct' AND reply IS NOT NULL",
  )

  return db
}

// ---------------------------------------------------------------------------
// Migrations — ordered, versioned, idempotent. `openDatabase` runs everything
// with `version > _schema_meta.version` (stored as a string in that table);
// fresh installs skip the list because the CREATE TABLE statements already
// reflect the latest schema. Add new migrations at the end with the next
// integer; never reorder existing ones.
// ---------------------------------------------------------------------------

type Migration = { version: number; name: string; up(db: Database): void }

/** Read a non-negative cursor high-water mark from an optional legacy table.
 * Migrations must tolerate partially-created databases left by older daemons,
 * but a present cursor with an invalid numeric shape is corruption and must
 * fail loud rather than silently reusing message sequence numbers. */
function optionalCursorMax(db: Database, table: string, column: string): number {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table) as {
    name: string
  } | null
  if (exists === null) return 0

  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  )
  if (!columns.has(column)) return 0

  const row = db.prepare(`SELECT COALESCE(MAX(${column}), 0) AS value FROM ${table}`).get() as {
    value: number
  }
  if (!Number.isSafeInteger(row.value) || row.value < 0) {
    throw new Error(`invalid ${table}.${column} cursor high-water mark: ${String(row.value)}`)
  }
  return row.value
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "add-sessions-optional-columns",
    up(db) {
      // Introspect rather than try/catch — keeps the upgrade silent on fresh
      // installs (CREATE TABLE already has these columns) and surgical on old
      // ones (only ADD what's missing).
      const cols = new Set(
        (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((r) => r.name),
      )
      const wanted: ReadonlyArray<readonly [string, string]> = [
        ["project_id", "TEXT"],
        ["claude_session_id", "TEXT"],
        ["claude_session_name", "TEXT"],
        ["last_delivered_ts", "INTEGER"],
        ["last_delivered_seq", "INTEGER DEFAULT 0"],
      ]
      for (const [name, spec] of wanted) {
        if (!cols.has(name)) db.run(`ALTER TABLE sessions ADD COLUMN ${name} ${spec}`)
      }
    },
  },
  {
    version: 2,
    name: "rename-heartbeat-to-updated-at-drop-pruned-at",
    up(db) {
      // Phase 2 of km-tribe.plateau: liveness is in-memory (clients Map),
      // not a periodic DB timer.
      try {
        db.run("ALTER TABLE sessions RENAME COLUMN heartbeat TO updated_at")
      } catch {
        /* already renamed */
      }
      try {
        db.run("ALTER TABLE sessions DROP COLUMN pruned_at")
      } catch {
        /* already dropped */
      }
      try {
        db.run("DROP INDEX IF EXISTS idx_sessions_pruned")
      } catch {
        /* ignore */
      }
    },
  },
  {
    version: 3,
    name: "collapse-events-into-messages",
    up(db) {
      // Phase 4 of km-tribe.plateau: each event row becomes a message with
      // type "event.<orig-type>", sender=<session>, recipient="log".
      try {
        db.run(`
          INSERT INTO messages (id, type, sender, recipient, content, bead_id, ref, ts)
          SELECT id, 'event.' || type, COALESCE(session, 'unknown'), 'log',
                 COALESCE(data, ''), bead_id, NULL, ts
          FROM events
        `)
        db.run("DROP TABLE events")
      } catch {
        /* fresh install or already migrated */
      }
    },
  },
  {
    version: 4,
    name: "drop-aliases",
    up(db) {
      // Phase 4 of km-tribe.plateau: renames update sessions.name in place.
      db.run("DROP TABLE IF EXISTS aliases")
    },
  },
  {
    version: 5,
    name: "drop-leadership-vestige",
    up(db) {
      // Phase 1 of km-tribe.plateau: chief is derived from connection order.
      // Old deployments still have a vestigial leadership row — drop it so no
      // ghost state can confuse a future schema read.
      db.run("DROP TABLE IF EXISTS leadership")
    },
  },
  {
    version: 6,
    name: "add-sessions-identity-token",
    up(db) {
      // Phase 1.5 of km-tribe.plateau: stable session identity across Claude
      // Code restarts. The proxy hashes (claude_session_id, project_path,
      // role_hint) and sends the result on register; the daemon adopts the
      // prior sessionId + name + role + cursor when the token matches an
      // inactive row.
      try {
        db.run("ALTER TABLE sessions ADD COLUMN identity_token TEXT")
      } catch {
        /* exists */
      }
      db.run("CREATE INDEX IF NOT EXISTS idx_sessions_identity ON sessions(identity_token)")
    },
  },
  {
    version: 7,
    name: "add-messages-kind-replace-log-sentinel",
    up(db) {
      // km-tribe.polish-sweep item 3: replace the `recipient='log'` string
      // sentinel with a typed `kind` column. Recipients go back to being real
      // names (session id or '*'); delivery filters on `kind='event'` to skip
      // journal rows.
      //
      // Fresh installs reach this point before the CREATE TABLE for messages
      // runs below — we guard by checking sqlite_master so the ALTER is only
      // issued against a pre-existing table. Fresh installs get the `kind`
      // column from the CREATE TABLE itself.
      const hasMessages = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get() as {
        name: string
      } | null
      if (!hasMessages) return
      const cols = new Set(
        (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((r) => r.name),
      )
      if (!cols.has("kind")) {
        db.run("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'direct'")
      }
      // Backfill: event rows (recipient='log') become kind='event' with recipient='*'.
      db.run("UPDATE messages SET kind = 'event' WHERE recipient = 'log'")
      db.run("UPDATE messages SET recipient = '*' WHERE recipient = 'log'")
      // Broadcasts to '*' that aren't events get tagged as kind='broadcast'
      // so the typed column is maximally informative after migration.
      db.run("UPDATE messages SET kind = 'broadcast' WHERE recipient = '*' AND kind = 'direct'")
    },
  },
  {
    version: 8,
    name: "merge-event-log-into-messages",
    up(db) {
      // km-tribe.polish-sweep item 9: `event_log` is redundant with
      // `messages WHERE kind='event'` (after v7) — logEvent() already writes
      // every event into `messages` on the current code path. The dual write
      // served observability in an earlier era; now the single source of truth
      // is `messages`. Backfill any orphan rows (events that never made it
      // into `messages`), then drop the table and its indexes.
      const hasEventLog = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_log'")
        .get() as { name: string } | null
      if (!hasEventLog) return
      // Backfill: any event_log row whose (ts, type) isn't represented as a
      // messages event row becomes one. We match conservatively on (ts, type)
      // — collisions are astronomically unlikely, and an accidental duplicate
      // is far less harmful than a silent data loss.
      db.run(`
        INSERT INTO messages (id, type, sender, recipient, kind, content, bead_id, ref, ts)
        SELECT
          lower(hex(randomblob(16))),
          'event.' || COALESCE(el.type, 'unknown'),
          COALESCE(s.name, 'unknown'),
          '*',
          'event',
          COALESCE(el.meta, ''),
          NULL,
          NULL,
          el.ts
        FROM event_log el
        LEFT JOIN sessions s ON s.id = el.session_id
        WHERE NOT EXISTS (
          SELECT 1 FROM messages m
          WHERE m.kind = 'event'
            AND m.ts = el.ts
            AND m.type = 'event.' || COALESCE(el.type, 'unknown')
        )
      `)
      db.run("DROP INDEX IF EXISTS idx_event_log_project_ts")
      db.run("DROP INDEX IF EXISTS idx_event_log_type")
      db.run("DROP TABLE event_log")
    },
  },
  {
    version: 9,
    name: "drop-cursors-and-reads",
    up(db) {
      // km-tribe.delivery-correctness P1.3: the event-bus (km-tribe.event-bus)
      // moved per-session delivery state onto `sessions.last_delivered_seq`,
      // making the `cursors` table redundant. `reads` had no post-event-bus
      // writer — markRead was never called on the live path. Drop both plus
      // their indexes.
      db.run("DROP INDEX IF EXISTS idx_reads_session")
      db.run("DROP TABLE IF EXISTS cursors")
      db.run("DROP TABLE IF EXISTS reads")
    },
  },
  {
    version: 10,
    name: "event-classification",
    up(db) {
      // km-tribe.event-classification: tag every event with a delivery class
      // (push = eligible for session fanout, pull = inbox-only) and a
      // response_expected hint (yes / no / optional). Adds rooms primitives
      // (Matrix-shape) plus per-session inbox cursor / mode / snooze and a
      // dismissals audit table. See vendor/tribe/CHANGELOG.md 0.12.0.
      //
      // Fresh-install guard: openDatabase() runs migrations BEFORE the
      // CREATE TABLE messages block (line ~63). On fresh installs the
      // messages table doesn't exist yet, but the CREATE TABLE below
      // already includes every column this migration adds — so we skip.
      const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get() as {
        name: string
      } | null
      if (!tableExists) return

      const messageCols = new Set(
        (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((r) => r.name),
      )
      if (!messageCols.has("response_expected")) {
        db.run("ALTER TABLE messages ADD COLUMN response_expected TEXT NOT NULL DEFAULT 'optional'")
      }
      if (!messageCols.has("delivery")) {
        db.run("ALTER TABLE messages ADD COLUMN delivery TEXT NOT NULL DEFAULT 'push'")
      }
      if (!messageCols.has("topic")) {
        db.run("ALTER TABLE messages ADD COLUMN topic TEXT")
      }
      if (!messageCols.has("room_id")) {
        db.run("ALTER TABLE messages ADD COLUMN room_id TEXT")
      }

      const sessionCols = new Set(
        (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((r) => r.name),
      )
      if (!sessionCols.has("last_inbox_pull_seq")) {
        db.run("ALTER TABLE sessions ADD COLUMN last_inbox_pull_seq INTEGER NOT NULL DEFAULT 0")
      }
      if (!sessionCols.has("mode")) {
        db.run("ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'normal'")
      }
      if (!sessionCols.has("snooze_until")) {
        db.run("ALTER TABLE sessions ADD COLUMN snooze_until INTEGER")
      }
      if (!sessionCols.has("snooze_kinds")) {
        db.run("ALTER TABLE sessions ADD COLUMN snooze_kinds TEXT")
      }

      // New tables — guarded by IF NOT EXISTS so re-runs are safe and fresh
      // installs (which already have these from the CREATE TABLE block) skip.
      db.run(`CREATE TABLE IF NOT EXISTS rooms (
				id           TEXT PRIMARY KEY,
				project_id   TEXT,
				name         TEXT,
				created_at   INTEGER NOT NULL,
				creator_id   TEXT,
				metadata     TEXT
			)`)
      db.run(`CREATE TABLE IF NOT EXISTS room_members (
				room_id     TEXT NOT NULL,
				session_id  TEXT NOT NULL,
				joined_at   INTEGER NOT NULL,
				role        TEXT NOT NULL DEFAULT 'member',
				PRIMARY KEY (room_id, session_id)
			)`)
      db.run(`CREATE TABLE IF NOT EXISTS dismissals (
				session_id TEXT NOT NULL,
				message_id TEXT NOT NULL,
				reason     TEXT,
				ts         INTEGER NOT NULL,
				PRIMARY KEY (session_id, message_id)
			)`)

      // Backfill: synthesize one default room per project_id, populate
      // messages.room_id, and join every existing session to its project room.
      // Sessions / messages without a project_id share the singleton 'default'
      // room — keeps the schema invariant (every event scoped to a room) without
      // forcing a project_id on legacy rows.
      //
      // Note: only sessions carries project_id. messages joins via sender →
      // sessions.name. Earlier draft of this migration UNIONed a phantom
      // messages.project_id and crashed on every existing v9 install.
      const now = Date.now()
      const projectRows = db
        .prepare("SELECT DISTINCT COALESCE(project_id, 'default') AS pid FROM sessions")
        .all() as Array<{ pid: string }>
      const insertRoom = db.prepare(
        "INSERT OR IGNORE INTO rooms (id, project_id, name, created_at) VALUES ($id, $pid, $name, $now)",
      )
      for (const row of projectRows) {
        const roomId = `room:${row.pid}`
        insertRoom.run({ $id: roomId, $pid: row.pid === "default" ? null : row.pid, $name: row.pid, $now: now })
      }
      // Backfill messages.room_id where unset.
      db.run(`UPDATE messages SET room_id = 'room:' || COALESCE(
				(SELECT s.project_id FROM sessions s WHERE s.name = messages.sender),
				'default'
			) WHERE room_id IS NULL`)
      // Backfill room_members from existing sessions.
      db.run(`INSERT OR IGNORE INTO room_members (room_id, session_id, joined_at, role)
				SELECT 'room:' || COALESCE(project_id, 'default'), id, started_at, role FROM sessions`)
    },
  },
  {
    version: 11,
    name: "filter-collapse",
    up(db) {
      // km-tribe.filter-collapse: rename sessions.mode/snooze_until/snooze_kinds
      // → filter_mode/filter_until/filter_mute; drop messages.response_expected
      // (the hint is derived from kind + sender at delivery time); drop the
      // dismissals table outright. The unified tribe.filter tool replaces the
      // prior trio — see plugins/claude/CHANGELOG.md for the migration guide.
      //
      // Fresh-install guard: openDatabase() runs migrations BEFORE the CREATE TABLE
      // statements above, so on a fresh install the relevant tables don't yet exist
      // and we have nothing to migrate. (The CREATE TABLE statements already use the
      // post-v11 column names.)
      const hasSessions = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get() as {
        name: string
      } | null
      if (hasSessions) {
        const sessionCols = new Set(
          (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((r) => r.name),
        )
        if (sessionCols.has("mode") && !sessionCols.has("filter_mode")) {
          db.run("ALTER TABLE sessions RENAME COLUMN mode TO filter_mode")
        }
        if (sessionCols.has("snooze_until") && !sessionCols.has("filter_until")) {
          db.run("ALTER TABLE sessions RENAME COLUMN snooze_until TO filter_until")
        }
        if (sessionCols.has("snooze_kinds") && !sessionCols.has("filter_mute")) {
          db.run("ALTER TABLE sessions RENAME COLUMN snooze_kinds TO filter_mute")
        }
      }

      const hasMessages = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get() as {
        name: string
      } | null
      if (hasMessages) {
        const messageCols = new Set(
          (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((r) => r.name),
        )
        if (messageCols.has("response_expected")) {
          // Bun ships SQLite ≥3.45 (DROP COLUMN landed in 3.35), so the simple
          // ALTER works without the legacy table-rebuild dance.
          db.run("ALTER TABLE messages DROP COLUMN response_expected")
        }
      }

      // Dismissals: drop outright. The audit/classifier-training rationale was
      // never connected to anything that consumed the rows.
      db.run("DROP INDEX IF EXISTS idx_dismissals_session")
      db.run("DROP TABLE IF EXISTS dismissals")
    },
  },
  {
    version: 12,
    name: "session-delivery-mode",
    up(db) {
      // km-bearly.tribe-dm-delivery-gap: each session declares how it consumes
      // messages — `push` (channel fanout, default for stdio clients with a
      // notification reader) or `pull` (queued; drained via tribe.fetch).
      // The daemon's broadcast pipeline skips socket fanout for
      // pull-mode recipients so MCP-only clients (codex, etc.) don't lose DMs
      // to /dev/null.
      const hasSessions = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get() as {
        name: string
      } | null
      if (hasSessions) {
        const cols = new Set(
          (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((r) => r.name),
        )
        if (!cols.has("delivery")) {
          db.run("ALTER TABLE sessions ADD COLUMN delivery TEXT NOT NULL DEFAULT 'push'")
        }
      }
    },
  },
  {
    version: 13,
    name: "topic-and-filter-mute",
    up(db) {
      const hasMessages = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get() as {
        name: string
      } | null
      if (hasMessages) {
        db.run("DROP INDEX IF EXISTS idx_messages_plugin_kind_ts")
        const messageCols = new Set(
          (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((r) => r.name),
        )
        if (messageCols.has("plugin_kind") && !messageCols.has("topic")) {
          db.run("ALTER TABLE messages RENAME COLUMN plugin_kind TO topic")
        } else if (!messageCols.has("topic")) {
          db.run("ALTER TABLE messages ADD COLUMN topic TEXT")
        } else if (messageCols.has("plugin_kind")) {
          db.run("UPDATE messages SET topic = plugin_kind WHERE topic IS NULL AND plugin_kind IS NOT NULL")
          db.run("ALTER TABLE messages DROP COLUMN plugin_kind")
        }
        db.run("CREATE INDEX IF NOT EXISTS idx_messages_topic_ts ON messages(topic, ts)")
      }

      const hasSessions = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get() as {
        name: string
      } | null
      if (hasSessions) {
        const sessionCols = new Set(
          (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((r) => r.name),
        )
        if (sessionCols.has("filter_kinds") && !sessionCols.has("filter_mute")) {
          db.run("ALTER TABLE sessions RENAME COLUMN filter_kinds TO filter_mute")
        } else if (!sessionCols.has("filter_mute")) {
          db.run("ALTER TABLE sessions ADD COLUMN filter_mute TEXT")
        } else if (sessionCols.has("filter_kinds")) {
          db.run(
            "UPDATE sessions SET filter_mute = filter_kinds WHERE filter_mute IS NULL AND filter_kinds IS NOT NULL",
          )
          db.run("ALTER TABLE sessions DROP COLUMN filter_kinds")
        }
      }
    },
  },
  {
    version: 14,
    name: "message-archive",
    up(db) {
      db.run(`CREATE TABLE IF NOT EXISTS messages_archive (
				seq         INTEGER NOT NULL,
				id          TEXT PRIMARY KEY,
				type        TEXT NOT NULL,
				sender      TEXT NOT NULL,
				recipient   TEXT NOT NULL,
				kind        TEXT NOT NULL DEFAULT 'direct',
				content     TEXT NOT NULL,
				bead_id     TEXT,
				ref         TEXT,
				ts          INTEGER NOT NULL,
				delivery    TEXT NOT NULL DEFAULT 'push',
				topic       TEXT,
				room_id     TEXT,
				archived_at INTEGER NOT NULL
			)`)
      db.run("CREATE INDEX IF NOT EXISTS idx_messages_archive_ts ON messages_archive(ts)")
      db.run("CREATE INDEX IF NOT EXISTS idx_messages_archive_seq ON messages_archive(seq)")
    },
  },
  {
    version: 15,
    name: "session-account-provider",
    up(db) {
      // @km/infra/15641 Phase 1 — per-session account/provider label.
      // ag (the source of truth for account/quota) sets TRIBE_ACCOUNT +
      // TRIBE_PROVIDER env vars when launching backends; the tribe
      // adapter forwards them in registration. Tribe stays uncoupled
      // from quota logic — it just stores the label so members listing
      // can answer "which account is each session on?".
      const hasSessions = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get() as {
        name: string
      } | null
      if (!hasSessions) return
      const cols = new Set(
        (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((r) => r.name),
      )
      if (!cols.has("account")) db.run("ALTER TABLE sessions ADD COLUMN account TEXT")
      if (!cols.has("provider")) db.run("ALTER TABLE sessions ADD COLUMN provider TEXT")
    },
  },
  {
    version: 16,
    name: "ball-tracker-request-reply",
    up(db) {
      // @km/tribe/message-ball-tracker — add `request` + `reply` columns to
      // messages + messages_archive so the daemon can track "who has the
      // ball" on tracked requests. Plus pending_request table holds one row
      // per (request_id, recipient) for fanout semantics (1:1, multi-target,
      // broadcast). See bead body for full design.
      const hasMessages = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get() as {
        name: string
      } | null
      if (hasMessages) {
        const msgCols = new Set(
          (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((r) => r.name),
        )
        if (!msgCols.has("request")) db.run("ALTER TABLE messages ADD COLUMN request TEXT")
        if (!msgCols.has("reply")) db.run("ALTER TABLE messages ADD COLUMN reply TEXT")
      }
      const hasArchive = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_archive'")
        .get() as { name: string } | null
      if (hasArchive) {
        const archCols = new Set(
          (db.prepare("PRAGMA table_info(messages_archive)").all() as Array<{ name: string }>).map((r) => r.name),
        )
        if (!archCols.has("request")) db.run("ALTER TABLE messages_archive ADD COLUMN request TEXT")
        if (!archCols.has("reply")) db.run("ALTER TABLE messages_archive ADD COLUMN reply TEXT")
      }
      db.run(`CREATE TABLE IF NOT EXISTS pending_request (
				request_id TEXT NOT NULL,
				recipient  TEXT NOT NULL,
				sender     TEXT NOT NULL,
				opened_at  INTEGER NOT NULL,
				message_id TEXT NOT NULL,
				fanout     TEXT NOT NULL DEFAULT 'first',
				PRIMARY KEY (request_id, recipient)
			)`)
      db.run("CREATE INDEX IF NOT EXISTS idx_pending_recipient ON pending_request(recipient)")
      db.run("CREATE INDEX IF NOT EXISTS idx_pending_sender ON pending_request(sender)")
    },
  },
  {
    version: 17,
    name: "add-messages-summary",
    up(db) {
      // llm-authored-tribe-summary-persistence (20316 #3): persist an authored
      // one-line summary alongside each message so the channel UI can show the
      // sender's own one-liner by default instead of a render-time heuristic.
      // Existing databases get a nullable column; fresh installs already have it
      // from the CREATE TABLE blocks above. Idempotent — introspect before ALTER.
      for (const table of ["messages", "messages_archive"]) {
        const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`).get() as {
          name: string
        } | null
        if (!exists) continue
        const cols = new Set(
          (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name),
        )
        if (!cols.has("summary")) db.run(`ALTER TABLE ${table} ADD COLUMN summary TEXT`)
      }
    },
  },
  {
    version: 18,
    name: "mailbox-cursors",
    up(db) {
      // 19442 undead reframe — recipient-keyed durable actionable cursor. The
      // CREATE TABLE in openDatabase covers fresh installs; existing databases
      // get the table here. No backfill: a missing row reads as cursor 0, and
      // the first acknowledging fetch for each mailbox writes the real value.
      db.run(`CREATE TABLE IF NOT EXISTS mailbox_cursors (
				recipient           TEXT PRIMARY KEY,
				last_actionable_seq INTEGER NOT NULL DEFAULT 0,
				updated_at          INTEGER NOT NULL
			)`)
    },
  },
  {
    version: 19,
    name: "session-launch-identity",
    up(db) {
      const cols = new Set(
        (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((row) => row.name),
      )
      if (!cols.has("launch_id")) db.run("ALTER TABLE sessions ADD COLUMN launch_id TEXT")
      if (!cols.has("launch_parent_pid")) db.run("ALTER TABLE sessions ADD COLUMN launch_parent_pid INTEGER")
      db.run("CREATE INDEX IF NOT EXISTS idx_sessions_launch_identity ON sessions(name, launch_id, launch_parent_pid)")
    },
  },
  {
    version: 20,
    name: "pending-request-expiry",
    up(db) {
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_request'")
        .get() as { name: string } | null
      if (!table) return
      const cols = new Set(
        (db.prepare("PRAGMA table_info(pending_request)").all() as Array<{ name: string }>).map((row) => row.name),
      )
      if (!cols.has("expires_at")) db.run("ALTER TABLE pending_request ADD COLUMN expires_at INTEGER")
      db.run("CREATE INDEX IF NOT EXISTS idx_pending_expiry ON pending_request(expires_at)")
    },
  },
  {
    version: 21,
    name: "launch-renames",
    up(db) {
      // 21454 — persisted runtime-rename authority keyed by launch identity.
      // The CREATE TABLE in openDatabase covers fresh installs; existing
      // databases get the table here. No backfill: a missing row reads as
      // "no runtime rename ever happened for this launch".
      db.run(`CREATE TABLE IF NOT EXISTS launch_renames (
				launch_id         TEXT NOT NULL,
				launch_parent_pid INTEGER NOT NULL,
				name              TEXT NOT NULL,
				renamed_at        INTEGER NOT NULL,
				PRIMARY KEY (launch_id, launch_parent_pid)
      )`)
    },
  },
  {
    version: 22,
    name: "mailbox-attention-read-receipts",
    up(db) {
      // Versioned fixtures and repaired databases may truthfully carry a
      // later schema stamp while lacking this independent table. Recreate the
      // v18 substrate before extending it so the receipt migration remains
      // idempotent across partial-but-supported upgrade shapes.
      db.run(`CREATE TABLE IF NOT EXISTS mailbox_cursors (
			recipient           TEXT PRIMARY KEY,
			last_actionable_seq INTEGER NOT NULL DEFAULT 0,
			updated_at          INTEGER NOT NULL,
			last_attention_read_at INTEGER
		)`)
      const cols = new Set(
        (db.prepare("PRAGMA table_info(mailbox_cursors)").all() as Array<{ name: string }>).map((row) => row.name),
      )
      if (!cols.has("last_attention_read_at")) {
        db.run("ALTER TABLE mailbox_cursors ADD COLUMN last_attention_read_at INTEGER")
      }
    },
  },
  {
    version: 23,
    name: "durable-message-sequence",
    up(db) {
      // Delivery and mailbox cursors use messages.rowid as their monotonic
      // sequence. SQLite may reuse an implicit rowid after retention empties a
      // table, which can strand fresh mail below a retained cursor. Rebuild
      // existing journals with an explicit AUTOINCREMENT `rowid` INTEGER
      // PRIMARY KEY. Naming the alias `rowid` preserves every existing cursor
      // query while sqlite_sequence prevents reuse; external payload queries
      // continue to list their public columns explicitly.
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get() as {
        name: string
      } | null
      if (!table) return

      const columns = new Set(
        (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((row) => row.name),
      )
      if (columns.has("rowid")) return

      // The hot journal may already be empty when this migration runs. Recover
      // its former sequence ceiling from every durable cursor/archive that can
      // outlive retention; otherwise AUTOINCREMENT would restart at 1 and new
      // mail could remain forever below a retained consumer cursor.
      const durableHighWater = Math.max(
        optionalCursorMax(db, "messages_archive", "seq"),
        optionalCursorMax(db, "sessions", "last_delivered_seq"),
        optionalCursorMax(db, "sessions", "last_inbox_pull_seq"),
        optionalCursorMax(db, "mailbox_cursors", "last_actionable_seq"),
      )

      db.run("BEGIN IMMEDIATE")
      try {
        db.run(`CREATE TABLE messages_v22 (
			rowid      INTEGER PRIMARY KEY AUTOINCREMENT,
			id         TEXT NOT NULL UNIQUE,
			type       TEXT NOT NULL,
			sender     TEXT NOT NULL,
			recipient  TEXT NOT NULL,
			kind       TEXT NOT NULL DEFAULT 'direct',
			content    TEXT NOT NULL,
			bead_id    TEXT,
			ref        TEXT,
			ts         INTEGER NOT NULL,
			delivery   TEXT NOT NULL DEFAULT 'push',
			topic      TEXT,
			room_id    TEXT,
			request    TEXT,
			reply      TEXT,
			summary    TEXT
		)`)
        db.run(`INSERT INTO messages_v22 (
			rowid, id, type, sender, recipient, kind, content, bead_id, ref, ts,
			delivery, topic, room_id, request, reply, summary
		)
		SELECT
			rowid, id, type, sender, recipient, kind, content, bead_id, ref, ts,
			delivery, topic, room_id, request, reply, summary
        FROM messages
        ORDER BY rowid`)
        db.run("DROP TABLE messages")
        db.run("ALTER TABLE messages_v22 RENAME TO messages")
        const currentSequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'messages'").get() as {
          seq: number
        } | null
        if (durableHighWater > (currentSequence?.seq ?? 0)) {
          if (currentSequence === null) {
            db.run("INSERT INTO sqlite_sequence (name, seq) VALUES ('messages', $seq)", {
              $seq: durableHighWater,
            } as never)
          } else {
            db.run("UPDATE sqlite_sequence SET seq = $seq WHERE name = 'messages'", {
              $seq: durableHighWater,
            } as never)
          }
        }
        db.run("COMMIT")
      } catch (error) {
        db.run("ROLLBACK")
        throw error
      }
    },
  },
  {
    version: 23,
    name: "turn-start-receipts",
    up(db) {
      db.run(`CREATE TABLE IF NOT EXISTS turn_start_receipts (
			receipt_seq           INTEGER PRIMARY KEY AUTOINCREMENT,
			session               TEXT NOT NULL,
			launch_id             TEXT NOT NULL,
			launch_parent_pid     INTEGER NOT NULL,
			controller_session_id TEXT NOT NULL,
			provider_session_id   TEXT NOT NULL,
			provider_turn_id      TEXT NOT NULL,
			started_at            INTEGER NOT NULL,
			received_at           INTEGER NOT NULL,
			UNIQUE (launch_id, launch_parent_pid, provider_session_id, provider_turn_id)
      )`)
    },
  },
  {
    version: 24,
    name: "response-attention-classification",
    up(db) {
      // Existing responses predate the surfaced-attention contract and may
      // number in the hundreds above an old actionable cursor. Preserve them
      // as ambient history rather than replaying that backlog on upgrade;
      // every response inserted after this migration is classified atomically
      // by insertMessage below.
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get() as {
        name: string
      } | null
      if (!table) return
      const columns = new Set(
        (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((row) => row.name),
      )
      if (!columns.has("attention_required")) {
        db.run("ALTER TABLE messages ADD COLUMN attention_required INTEGER NOT NULL DEFAULT 0")
      }
    },
  },
  {
    version: 25,
    name: "validated-reply-correlation",
    up(db) {
      for (const table of ["messages", "messages_archive"]) {
        const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`).get() as {
          name: string
        } | null
        if (!exists) continue
        const columns = new Set(
          (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
        )
        if (!columns.has("correlated_reply_requester")) {
          db.run(`ALTER TABLE ${table} ADD COLUMN correlated_reply_requester TEXT`)
        }
      }
    },
  },
  {
    version: 26,
    name: "pending-request-kind",
    up(db) {
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_request'")
        .get() as { name: string } | null
      if (!table) return
      const columns = new Set(
        (db.prepare("PRAGMA table_info(pending_request)").all() as Array<{ name: string }>).map((row) => row.name),
      )
      // Existing rows cannot be classified safely from their id spelling:
      // ordinary production requests already use three colon-separated parts.
      // Preserve them as closable requests. A live incident's next assertion
      // promotes its existing row through openIncidentRequest below.
      if (!columns.has("request_kind")) {
        db.run(
          "ALTER TABLE pending_request ADD COLUMN request_kind TEXT NOT NULL DEFAULT 'request' CHECK (request_kind IN ('request', 'incident'))",
        )
      }
    },
  },
  {
    version: 27,
    name: "message-provenance",
    /**
     * A message row named its sender and nothing else — `sender` is a
     * self-reported NAME, so no row could be traced to the process that wrote
     * it. Identifying one noisy emitter meant reading source headers and a
     * process listing by hand. `session_id` is stamped at insert from the
     * daemon's own connection context (never caller-asserted), and `sessions`
     * carries pid / cwd / launch_id, so one join answers "what wrote this".
     *
     * `attention_required` is added to the ARCHIVE half here as a bug fix:
     * migration v24 added it to `messages` only, and `archiveExpiredMessages`
     * uses an explicit column list — so every message's attention
     * classification was silently dropped on archival, with no error. A new
     * column would have inherited exactly that fate.
     */
    up(db) {
      for (const table of ["messages", "messages_archive"]) {
        const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`).get() as {
          name: string
        } | null
        if (!exists) continue
        const columns = new Set(
          (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
        )
        if (!columns.has("session_id")) db.run(`ALTER TABLE ${table} ADD COLUMN session_id TEXT`)
        if (table === "messages_archive" && !columns.has("attention_required")) {
          db.run("ALTER TABLE messages_archive ADD COLUMN attention_required INTEGER NOT NULL DEFAULT 0")
        }
      }
    },
  },
  {
    version: 28,
    name: "session-self-mailbox-authority",
    up(db) {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((row) => row.name),
      )
      if (!columns.has("mailbox_authority_hash")) {
        db.run("ALTER TABLE sessions ADD COLUMN mailbox_authority_hash TEXT")
      }
      db.run(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_mailbox_authority ON sessions(mailbox_authority_hash) WHERE mailbox_authority_hash IS NOT NULL",
      )
    },
  },
]

/** The schema terminus `openDatabase` upgrades to — derived from the same
 * `MIGRATIONS.at(-1)` it uses, so a test can never pin a stale literal. */
export const CURRENT_SCHEMA_VERSION: number = MIGRATIONS.at(-1)!.version

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

/**
 * The default-wake/stop-line message types — the ONE canonical set (19442). A
 * DIRECT message of one of these types addressed to a name is "actionable": it
 * opens work the recipient must act on. `inbox.wait` gates on it and the
 * chief-absence watchdog counts it. Durable attention additionally carries
 * newly classified direct responses without making them default wakeups.
 */
export const ACTIONABLE_TYPES = TRIBE_ACTIONABLE_TYPES
export const ACTIONABLE_TYPES_SET: ReadonlySet<string> = new Set(ACTIONABLE_TYPES)
export const CORRELATED_REPLY_TYPES = ["response", "status"] as const
export const CORRELATED_REPLY_TYPES_SET: ReadonlySet<string> = new Set(CORRELATED_REPLY_TYPES)
/** Direct types that implicitly open a semantic response ball. Verdict remains
 * wakeable/actionable but does not manufacture a second obligation unless the
 * sender explicitly supplies `request`. */
export const AUTO_TRACK_TYPES = TRIBE_AUTO_TRACK_TYPES
export const AUTO_TRACK_TYPES_SET: ReadonlySet<string> = new Set(AUTO_TRACK_TYPES)
export const ACTIONABLE_TYPES_SQL = ACTIONABLE_TYPES.map((t) => `'${t}'`).join(", ")
export const CORRELATED_REPLY_TYPES_SQL = CORRELATED_REPLY_TYPES.map((type) => `'${type}'`).join(", ")
/** One canonical durable-attention classification: default-wake actionables
 * plus rows atomically classified at insertion (currently direct responses). */
export const ATTENTION_PREDICATE_SQL = `(type IN (${ACTIONABLE_TYPES_SQL}) OR attention_required = 1)`

/**
 * Selective reply retirement over the existing durable message correlation.
 * A recipient-wide cursor cannot express this safely: advancing it for one
 * reply could swallow an unrelated older actionable row.
 */
export function unretiredAttentionPredicateSql(
  alias: string,
  source: { readonly relation: "messages" | "journal"; readonly sequence: "rowid" | "seq" } = {
    relation: "messages",
    sequence: "rowid",
  },
): string {
  const row = `${alias}.`
  /** One "has a reply already landed?" probe against one physical table. */
  const noReplyIn = (table: string, sequence: string, as: string) => `NOT EXISTS (
    SELECT 1
    FROM ${table} AS ${as}
    WHERE ${as}.kind = 'direct'
      AND ${as}.sender = ${row}recipient
      AND ${as}.recipient = ${row}sender
      AND ${as}.${sequence} > ${row}${source.sequence}
      AND ${as}.reply = COALESCE(${row}request, ${row}id)
  )`

  if (source.relation === "messages") return noReplyIn("messages", "rowid", "reply_message")

  // `journal` is a CTE — `messages UNION ALL messages_archive`. Probing it
  // directly forced SQLite to MATERIALISE all ~158k rows and then scan that
  // materialisation once per candidate row, because a CTE carries no indexes.
  // Splitting the probe across the two base tables asks the same question —
  // "no reply anywhere in the journal" is "no reply in messages AND none in
  // the archive", and the two share one sequence space — but each half is now
  // an index lookup. Measured on the live journal: projectHealthCadence across
  // 30 sessions fell from 6,339 ms / 1,656,368 page reads to 456 ms / 364,091.
  //
  // The residue is the OUTER `FROM journal AS m`, which still materialises the
  // union once per statement. That is linear in journal size rather than
  // quadratic, and removing it means splitting three aggregate queries across
  // both tables and recombining in TypeScript — a separate change against an
  // on-demand path, not this one against the continuous burn.
  return `${noReplyIn("messages", "rowid", "reply_message")}
    AND ${noReplyIn("messages_archive", "seq", "reply_archived")}`
}

export type TribeStatements = ReturnType<typeof createStatements>

export function createStatements(db: Database) {
  return {
    // Identity omission is not revocation. A legacy provider-parent transport
    // can reconnect before its launch-bearing child after daemon restart; the
    // adopted durable member must retain the provenance that child promoted.
    // Explicit non-null values still replace the prior identity.
    upsertSession: db.prepare(`
		INSERT INTO sessions (id, name, role, domains, pid, cwd, project_id, claude_session_id, claude_session_name, identity_token, mailbox_authority_hash, launch_id, launch_parent_pid, started_at, updated_at, delivery, account, provider)
		VALUES ($id, $name, $role, $domains, $pid, $cwd, $project_id, $claude_session_id, $claude_session_name, $identity_token, $mailbox_authority_hash, $launch_id, $launch_parent_pid, $now, $now, COALESCE($delivery, 'push'), $account, $provider)
		ON CONFLICT(id) DO UPDATE SET
			name = $name, role = $role, domains = $domains,
			pid = $pid, cwd = $cwd, project_id = $project_id, claude_session_id = $claude_session_id,
			claude_session_name = $claude_session_name,
			identity_token = COALESCE($identity_token, identity_token),
			mailbox_authority_hash = COALESCE($mailbox_authority_hash, mailbox_authority_hash),
			launch_id = COALESCE($launch_id, launch_id),
			launch_parent_pid = COALESCE($launch_parent_pid, launch_parent_pid),
			started_at = $now, updated_at = $now,
			delivery = COALESCE($delivery, delivery, 'push'),
			account = COALESCE($account, account),
			provider = COALESCE($provider, provider)
	`),

    insertMessage: db.prepare(`
		INSERT OR IGNORE INTO messages (id, type, sender, recipient, kind, content, bead_id, ref, ts,
			delivery, topic, room_id, request, reply, correlated_reply_requester, summary, session_id, attention_required)
		VALUES ($id, $type, $sender, $recipient, $kind, $content, $bead_id, $ref, $ts,
			$delivery, $topic, $room_id, $request, $reply, $correlated_reply_requester, $summary, $session_id,
			CASE
				WHEN $attention_required = 1 THEN 1
				WHEN $kind = 'direct' AND $sender != $recipient AND $type = 'response' THEN 1
				ELSE 0
			END)
	`),

    selectMessageById: db.prepare("SELECT rowid, ts FROM messages WHERE id = $id"),

    /** The question body for an owed ball (22844). The messages table — not
     *  any windowed read — is the true retention bound; pending views join
     *  through this so an obligation is never listed without its question. */
    selectMessageContentById: db.prepare("SELECT content FROM messages WHERE id = $id"),

    /** Ball-tracker insert: opens a new pending request (one row per recipient).
     *  See @km/tribe/message-ball-tracker Phase 2. */
    openPendingRequest: db.prepare(`
		INSERT INTO pending_request (request_id, recipient, sender, opened_at, expires_at, message_id, fanout)
		VALUES ($request_id, $recipient, $sender, $opened_at, $expires_at, $message_id, $fanout)
		ON CONFLICT(request_id, recipient) DO NOTHING
	`),

    /** Incident insert: the typed discriminator, not the request-id spelling,
     *  owns emitter-only settlement. Reassertion promotes a legacy row after
     *  migration and removes the request deadline. `opened_at` is DELIBERATELY
     *  preserved across reassertion — it is the demand instant the rung-5
     *  escalation fold measures standing duration against (@hab/core
     *  wait-watch.ts: "the daemon upserts never touch it"); resetting it on
     *  every tick would make every incident look freshly opened forever and
     *  escalation could never fire.
     *
     *  `message_id` is NOT preserved (@hh/pm/@i/5-no-wedged-agents/22964,
     *  2026-08-19 — was previously frozen alongside opened_at, undocumented
     *  and untested): it is repointed at the reasserting tick's own message
     *  on every upsert, so a reader's displayed content (counts, ages,
     *  example refs) reflects THIS tick rather than whichever tick first
     *  opened the ball. Measured before this fix: a re-evaluating watcher
     *  could tick correctly for days while `tribe pending` still showed text
     *  frozen at first-open — one incident named a specific ball as still
     *  waiting five minutes after that exact ball had been closed, with its
     *  age frozen at the ball's original two-day-old open time. */
    openIncidentRequest: db.prepare(`
		INSERT INTO pending_request (
			request_id, recipient, sender, opened_at, expires_at, message_id, fanout, request_kind
		)
		VALUES ($request_id, $recipient, $sender, $opened_at, NULL, $message_id, $fanout, 'incident')
		ON CONFLICT(request_id, recipient) DO UPDATE SET
			request_kind = 'incident',
			expires_at = NULL,
			message_id = excluded.message_id
	`),

    /** Ball-tracker close: deletes pending_request rows for a given (request_id, recipient).
     *  In single-recipient and multi-target cases this matches one row; in broadcast cases
     *  with fanout='first' it deletes all rows for the request when ANY recipient replies. */
    closePendingRequest: db.prepare(`
		DELETE FROM pending_request WHERE request_id = $request_id AND recipient = $recipient
	`),

    /** Ball-tracker close-all: for fanout='first' on broadcast, deletes ALL rows on first reply. */
    closePendingRequestAll: db.prepare(`
		DELETE FROM pending_request WHERE request_id = $request_id
	`),

    /** Daemon-owned expiry-observation input. Deadline passage changes the
     *  row's read projection, never its active ownership. Exclude obligations
     *  whose durable edge is already present in either retention tier so an
     *  arbitrary number of later daemon operations cannot duplicate it. */
    selectExpiredPendingRequests: db.prepare(`
		SELECT p.request_id, p.recipient, p.sender, p.opened_at, p.expires_at, p.message_id, p.fanout,
			COALESCE(m.summary, a.summary) AS summary
		FROM pending_request p
		LEFT JOIN messages m ON m.id = p.message_id
		LEFT JOIN messages_archive a ON a.id = p.message_id
		WHERE p.expires_at IS NOT NULL AND p.expires_at <= $now
			AND NOT EXISTS (
				SELECT 1
				FROM (
					SELECT ref, content FROM messages
					WHERE kind = 'event' AND type = 'event.ball.expired'
					UNION ALL
					SELECT ref, content FROM messages_archive
					WHERE kind = 'event' AND type = 'event.ball.expired'
				) expiry
				WHERE expiry.ref = p.request_id
					AND json_extract(expiry.content, '$.recipient') = p.recipient
					AND json_extract(expiry.content, '$.message_id') = p.message_id
			)
		ORDER BY p.opened_at, p.request_id, p.recipient
	`),

    /** Historical unanswered outcomes derive from the journal rather than a
     *  second tracker table. Deadline observations and terminal non-reply
     *  settlements are separate facts; the read fold preserves that distinction.
     *  UNION spans both retention tiers and deduplicates an interrupted archive. */
    selectPendingOutcomeFacts: db.prepare(`
		SELECT id, type, content, ts FROM messages
		WHERE kind = 'event' AND type IN ('event.ball.expired', 'event.ball.settled')
		UNION
		SELECT id, type, content, ts FROM messages_archive
		WHERE kind = 'event' AND type IN ('event.ball.expired', 'event.ball.settled')
		ORDER BY ts, id
	`),

    /** Answers are already durable message facts. Keep responder identity so
     *  fanout=all closes only that owner's outcome while fanout=first closes
     *  the shared request for every snapshotted owner. */
    selectPendingReplyFacts: db.prepare(`
		SELECT sender, reply FROM messages
		WHERE kind = 'direct' AND reply IS NOT NULL
		UNION
		SELECT sender, reply FROM messages_archive
		WHERE kind = 'direct' AND reply IS NOT NULL
		ORDER BY reply, sender
	`),

    /** Ball-tracker lookup: used when a reply arrives to decide whether this
     *  recipient's row is still active and whether fanout='first' closes all
     *  or fanout='all' closes only the replying recipient. */
    selectPendingForReplyRecipient: db.prepare(`
			SELECT request_id, fanout, expires_at, sender, request_kind
			FROM pending_request
			WHERE recipient = $recipient
				AND (request_id = $reply_id OR message_id = $reply_id)
			ORDER BY CASE WHEN request_id = $reply_id THEN 0 ELSE 1 END
			LIMIT 1
		`),

    /** Exact persisted discriminator for recipient-side close authority. */
    selectPendingKindForRecipient: db.prepare(`
		SELECT request_kind
		FROM pending_request
		WHERE recipient = $recipient AND request_id = $request_id
		LIMIT 1
	`),

    /** Full evidence for one exact owner row before a non-reply settlement. */
    selectPendingSettlementForRecipient: db.prepare(`
		SELECT p.request_id, p.recipient, p.sender, p.opened_at, p.expires_at, p.message_id, p.fanout,
			COALESCE(m.summary, a.summary) AS summary
		FROM pending_request p
		LEFT JOIN messages m ON m.id = p.message_id
		LEFT JOIN messages_archive a ON a.id = p.message_id
		WHERE p.recipient = $recipient AND p.request_id = $request_id
		LIMIT 1
	`),

    /** Full evidence for every owner of a semantic request before a shared
     *  non-reply settlement such as incident clear. */
    selectPendingSettlementsForRequest: db.prepare(`
		SELECT p.request_id, p.recipient, p.sender, p.opened_at, p.expires_at, p.message_id, p.fanout,
			COALESCE(m.summary, a.summary) AS summary
		FROM pending_request p
		LEFT JOIN messages m ON m.id = p.message_id
		LEFT JOIN messages_archive a ON a.id = p.message_id
		WHERE p.request_id = $request_id
		ORDER BY p.recipient
	`),

    /** Full evidence for retention settlement. Selection precedes deletion so
     *  gc-expired records what was never answered, not merely a count. */
    selectPendingSettlementsBefore: db.prepare(`
		SELECT p.request_id, p.recipient, p.sender, p.opened_at, p.expires_at, p.message_id, p.fanout,
			COALESCE(m.summary, a.summary) AS summary
		FROM pending_request p
		LEFT JOIN messages m ON m.id = p.message_id
		LEFT JOIN messages_archive a ON a.id = p.message_id
		WHERE p.opened_at < $cutoff
		ORDER BY p.opened_at, p.request_id, p.recipient
	`),

    selectPendingSettlementsForRecipientBefore: db.prepare(`
		SELECT p.request_id, p.recipient, p.sender, p.opened_at, p.expires_at, p.message_id, p.fanout,
			COALESCE(m.summary, a.summary) AS summary
		FROM pending_request p
		LEFT JOIN messages m ON m.id = p.message_id
		LEFT JOIN messages_archive a ON a.id = p.message_id
		WHERE p.recipient = $recipient AND p.opened_at < $cutoff
		ORDER BY p.opened_at, p.request_id
	`),

    /** Ball-tracker query: open requests addressed to a particular recipient (the "owner"
     *  of the open ball). Sorted oldest-first so callers can act on the longest-pending. */
    selectPendingForRecipient: db.prepare(`
		SELECT p.request_id, p.recipient, p.sender, p.opened_at, p.expires_at, p.message_id, p.fanout,
			p.request_kind,
			COALESCE(m.summary, a.summary) AS summary
		FROM pending_request p
		LEFT JOIN messages m ON m.id = p.message_id
		LEFT JOIN messages_archive a ON a.id = p.message_id
		WHERE p.recipient = $recipient
		ORDER BY p.opened_at ASC
	`),

    /** Full active pending surface for one owner. Unlike the attention query
     *  above, this deliberately joins question bodies in the same statement
     *  so snapshot cost does not grow by one query per ball. */
    selectPendingForRecipientWithContent: db.prepare(`
		SELECT p.request_id, p.recipient, p.sender, p.opened_at, p.expires_at, p.message_id, p.fanout,
			p.request_kind,
			COALESCE(m.summary, a.summary) AS summary,
			COALESCE(m.content, a.content) AS content
		FROM pending_request p
		LEFT JOIN messages m ON m.id = p.message_id
		LEFT JOIN messages_archive a ON a.id = p.message_id
		WHERE p.recipient = $recipient
		ORDER BY p.opened_at ASC
	`),

    /** Fleet attention projection: every open request grouped by its current
     *  recipient owner. This reads the existing tracker; it is not a second
     *  queue or ownership store. */
    selectAllPendingRequests: db.prepare(`
		SELECT p.request_id, p.recipient, p.sender, p.opened_at, p.expires_at, p.message_id, p.fanout,
			p.request_kind,
			COALESCE(m.summary, a.summary) AS summary
		FROM pending_request p
		LEFT JOIN messages m ON m.id = p.message_id
		LEFT JOIN messages_archive a ON a.id = p.message_id
		ORDER BY p.recipient ASC, p.opened_at ASC
	`),

    /** Full fleet-wide active pending surface. Health/attention consumers keep
     *  using selectAllPendingRequests above; only the explicit pending read
     *  pays to return bodies, and it does so in one bounded statement. */
    selectAllPendingRequestsWithContent: db.prepare(`
		SELECT p.request_id, p.recipient, p.sender, p.opened_at, p.expires_at, p.message_id, p.fanout,
			p.request_kind,
			COALESCE(m.summary, a.summary) AS summary,
			COALESCE(m.content, a.content) AS content
		FROM pending_request p
		LEFT JOIN messages m ON m.id = p.message_id
		LEFT JOIN messages_archive a ON a.id = p.message_id
		ORDER BY p.recipient ASC, p.opened_at ASC
	`),

    /** Ball-tracker GC (@km/tribe/20008): delete pending rows opened before a
     *  cutoff. A ball that never got a reply (dead recipient, out-of-band close,
     *  bead-closed handoff) otherwise stays "open" forever and pollutes
     *  tribe.pending. Deletes only the ball-tracker row — message history is
     *  untouched. Global form drives the periodic cleanup. */
    gcStalePendingRequests: db.prepare("DELETE FROM pending_request WHERE opened_at < $cutoff"),

    /** Ball-tracker GC scoped to one recipient — the EXPLICIT repair path
     *  (tribe.pending prune) safe to run during chief recovery: only deletes the
     *  owner's balls older than the cutoff; fresh balls + other recipients are
     *  untouched. */
    gcStalePendingForRecipient: db.prepare(
      "DELETE FROM pending_request WHERE recipient = $recipient AND opened_at < $cutoff",
    ),

    // -------------------------------------------------------------------
    // Journal retention (retention.ts) — additive statements only. The
    // dynamic-length INSERT/DELETE ... WHERE id IN (...) batch operations
    // are built at call time in retention.ts (ids per batch vary), mirroring
    // reapStaleTransportRows's placeholder pattern above; only the
    // fixed-shape reads live here.
    // -------------------------------------------------------------------

    /** Archive-move batch candidates: live messages old enough to move to
     *  messages_archive, oldest-first, LIMIT-bounded so one sweep tick never
     *  pays for a full-table pass. Same source predicate as the existing
     *  unbounded archiveExpiredMessages (session.ts cleanupOldData, which
     *  keeps running unchanged); this bounded, independently-configurable
     *  batch is a defense-in-depth second mover, not a replacement. */
    selectMessagesToArchiveBatch: db.prepare(`
		SELECT rowid, id FROM messages WHERE ts < $cutoff ORDER BY rowid ASC LIMIT $limit
	`),

    /** Live-cursor floor, half 1: the oldest un-acknowledged actionable-
     *  attention position recorded across every recipient's durable mailbox
     *  cursor. A messages_archive row at or below this seq has been
     *  acknowledged by every recipient who has ever acknowledged anything —
     *  see unretiredAttentionPredicateSql's mailbox_cursors comparisons,
     *  which this mirrors. NULL (no cursor rows at all, e.g. a fresh DB)
     *  contributes no constraint; retention.ts treats that as "unbounded". */
    selectMailboxCursorFloor: db.prepare("SELECT MIN(last_actionable_seq) AS floor FROM mailbox_cursors"),

    /** Live-cursor floor, half 2: the oldest ambient inbox-pull position
     *  recorded across every session row. mailbox_cursors alone only guards
     *  direct actionable messages (see health-cadence.ts's
     *  actionableLagQuery, scoped to kind='direct'); the ambient lag query
     *  there also counts broadcast rows (recipient = '*') against each
     *  session's own last_inbox_pull_seq, so retention takes the floor
     *  across both cursor families rather than mailbox_cursors alone. */
    selectSessionInboxCursorFloor: db.prepare("SELECT MIN(last_inbox_pull_seq) AS floor FROM sessions"),

    /** Archive-delete batch candidates: archived rows old enough under the
     *  (longer, independently configurable) delete window, at or below the
     *  live-cursor floor, and not referenced by any open ball — a ball's
     *  message_id must stay resolvable via the messages/messages_archive
     *  LEFT JOIN pattern every pending* query already uses (@km/tribe/22844,
     *  ae49897). Oldest-first, LIMIT-bounded. */
    selectArchiveDeleteBatch: db.prepare(`
		SELECT a.id, a.seq
		FROM messages_archive a
		WHERE a.ts < $cutoff
			AND a.seq <= $cursor_floor
			AND NOT EXISTS (SELECT 1 FROM pending_request p WHERE p.message_id = a.id)
		ORDER BY a.seq ASC
		LIMIT $limit
	`),

    /** Diagnostic companion to selectArchiveDeleteBatch: same age predicate,
     *  reports how many rows the two exclusion rules are holding back so a
     *  disabled-by-exclusion or otherwise ineffective sweep is debuggable
     *  from its logged counts rather than silently doing nothing (NO SILENT
     *  ERRORS). Bounded to the ts<cutoff slice via idx_messages_archive_ts —
     *  not a full-table scan. */
    selectArchiveDeleteDiagnostics: db.prepare(`
		SELECT
			COUNT(*) AS eligible_by_age,
			SUM(CASE WHEN a.seq > $cursor_floor THEN 1 ELSE 0 END) AS excluded_by_cursor,
			SUM(CASE WHEN EXISTS (SELECT 1 FROM pending_request p WHERE p.message_id = a.id) THEN 1 ELSE 0 END) AS excluded_by_pending
		FROM messages_archive a
		WHERE a.ts < $cutoff
	`),

    allSessions: db.prepare(
      "SELECT id, name, role, domains, pid, cwd, project_id, claude_session_id, claude_session_name, mailbox_authority_hash, launch_id, launch_parent_pid, started_at, updated_at, filter_mode, filter_until, filter_mute, last_inbox_pull_seq, delivery FROM sessions",
    ),

    /** Look up a connected session's delivery mode by id. Used by the broadcast
     *  pipeline to skip socket fanout for pull-mode recipients
     *  (km-bearly.tribe-dm-delivery-gap). Delivery is a per-connection
     *  transport property; duplicate visible names can exist when a host
     *  adapter and a backend tool adapter both represent one agent identity. */
    getSessionDeliveryById: db.prepare("SELECT delivery FROM sessions WHERE id = $id LIMIT 1"),

    /** Update a session's delivery mode in place. */
    setSessionDelivery: db.prepare("UPDATE sessions SET delivery = $delivery, updated_at = $now WHERE id = $id"),

    messageHistory: db.prepare(`
		SELECT * FROM messages
		WHERE (sender = $name OR recipient = $name OR recipient = '*')
		AND kind != 'event'
		ORDER BY ts DESC
		LIMIT $limit
	`),

    checkNameTaken: db.prepare("SELECT id FROM sessions WHERE name = $name AND id != $session_id"),

    renameSession: db.prepare("UPDATE sessions SET name = $new_name, updated_at = $now WHERE id = $session_id"),

    // 21454 — runtime-rename write-through + register-time re-application.
    upsertLaunchRename: db.prepare(
      "INSERT INTO launch_renames (launch_id, launch_parent_pid, name, renamed_at) VALUES ($launch_id, $launch_parent_pid, $name, $now) " +
        "ON CONFLICT(launch_id, launch_parent_pid) DO UPDATE SET name = $name, renamed_at = $now",
    ),
    getLaunchRename: db.prepare(
      "SELECT name FROM launch_renames WHERE launch_id = $launch_id AND launch_parent_pid = $launch_parent_pid",
    ),
    getSessionsByLaunchId: db.prepare(
      "SELECT name, launch_parent_pid FROM sessions WHERE launch_id = $launch_id ORDER BY id",
    ),
    // Trust roster. Prepared once here rather than re-compiled per attention
    // read, which is where it used to live.
    sessionRoster: db.prepare("SELECT name, role FROM sessions"),
    // `substr(launch_id, 1, length($p)) = $p` wrapped the indexed column in a
    // function, so SQLite had to compute it for every row: a full scan of
    // `sessions` on every managed-inbox request, whose cost tracked the row
    // count the register/die leak was inflating. The half-open range
    // `$derived_prefix <= launch_id < $derived_prefix_upper` selects exactly
    // the same rows — every string with that prefix sorts inside it under
    // BINARY collation — while remaining a range scan idx_sessions_launch_id
    // can serve. See derivedLaunchPrefixUpperBound for the upper bound.
    getSessionsByProviderLaunchId: db.prepare(
      "SELECT name, launch_id, launch_parent_pid FROM sessions " +
        "WHERE launch_id = $launch_id " +
        "OR (launch_id >= $derived_prefix AND launch_id < $derived_prefix_upper) ORDER BY id",
    ),
    insertTurnStartReceipt: db.prepare(`
      INSERT OR IGNORE INTO turn_start_receipts (
        session, launch_id, launch_parent_pid, controller_session_id,
        provider_session_id, provider_turn_id, started_at, received_at
      ) VALUES (
        $session, $launch_id, $launch_parent_pid, $controller_session_id,
        $provider_session_id, $provider_turn_id, $started_at, $received_at
      )
    `),
    getLatestTurnStartReceipt: db.prepare(`
      SELECT receipt_seq, session, launch_id, launch_parent_pid,
             controller_session_id, provider_session_id, provider_turn_id,
             started_at, received_at
      FROM turn_start_receipts
      WHERE session = $session
        AND launch_id = $launch_id
        AND launch_parent_pid = $launch_parent_pid
      ORDER BY receipt_seq DESC
      LIMIT 1
    `),
    gcOldLaunchRenames: db.prepare("DELETE FROM launch_renames WHERE renamed_at < $cutoff"),

    updateSessionMeta: db.prepare(`
		UPDATE sessions SET name = $name, role = $role, domains = $domains,
			account = COALESCE($account, account),
			provider = COALESCE($provider, provider),
			pid = COALESCE($pid, pid),
			cwd = COALESCE($cwd, cwd),
			updated_at = $now
		WHERE id = $id
	`),

    promoteSessionLaunchIdentity: db.prepare(`
		UPDATE sessions SET
			identity_token = COALESCE(identity_token, $identity_token),
			launch_id = $launch_id,
			launch_parent_pid = $launch_parent_pid,
			updated_at = $now
		WHERE id = $id
			AND (
				(launch_id IS NULL AND launch_parent_pid IS NULL)
				OR (launch_id = $launch_id AND launch_parent_pid = $launch_parent_pid)
			)
	`),

    hasRecentMessage: db.prepare(`
		SELECT 1 FROM messages WHERE content LIKE $prefix || '%' AND ts > $since LIMIT 1
	`),

    // Atomic dedup: INSERT OR IGNORE — first session to claim a key wins, others get changes=0
    claimDedup: db.prepare("INSERT OR IGNORE INTO dedup (key, session_id, ts) VALUES ($key, $session_id, $ts)"),

    // Chief-silent watchdog / inbox.wait: count actionables the recipient has
    // not acknowledged through the canonical recipient mailbox. Ambient pull
    // progress is deliberately irrelevant: attention can deliver a later
    // verdict ahead of a health/status page, and that delivery must re-arm the
    // actionable wait without draining the ambient tail.
    getUnreadDms: db.prepare(`
      SELECT
        COUNT(*) AS count,
        COALESCE(MIN(ts), 0) AS oldest_ts
      FROM messages AS m
      WHERE m.recipient = $name
        AND m.kind = 'direct'
        AND m.sender != $name
        AND m.type IN (${ACTIONABLE_TYPES_SQL})
        AND ${unretiredAttentionPredicateSql("m")}
        AND m.rowid > COALESCE((SELECT last_actionable_seq FROM mailbox_cursors WHERE recipient = $name), 0)
    `),

    /** Structural tail of the same actionable-mailbox projection. Await
     * supervisors use this cursor/id/type tuple to plan delivery without
     * copying message content across the control plane. */
    getLatestActionableAttention: db.prepare(`
      SELECT rowid, id, type
      FROM messages AS m
      WHERE m.recipient = $name
        AND m.kind = 'direct'
        AND m.sender != $name
        AND m.type IN (${ACTIONABLE_TYPES_SQL})
        AND ${unretiredAttentionPredicateSql("m")}
        AND m.rowid > COALESCE((SELECT last_actionable_seq FROM mailbox_cursors WHERE recipient = $name), 0)
      ORDER BY m.rowid DESC
      LIMIT 1
    `),

    /** One qualifying-tail predicate with two explicit projections. Fresh
     * waits request the cursor-aware current tail; reconnecting chunks request
     * the durable tail so a row inserted and acknowledged between transports
     * is still observed relative to the logical wait baseline. */
    getLatestInboxWaitMessage: db.prepare(`
      SELECT rowid
      FROM messages AS m
      WHERE m.recipient = $name
        AND m.kind = 'direct'
        AND m.sender != $name
        AND ${unretiredAttentionPredicateSql("m")}
        AND (
          type IN (${ACTIONABLE_TYPES_SQL})
          OR (
            $include_correlated_replies = 1
            AND type IN (${CORRELATED_REPLY_TYPES_SQL})
            AND correlated_reply_requester = $name
          )
        )
        AND (
          $unacknowledged_only = 0
          OR m.rowid > COALESCE((SELECT last_actionable_seq FROM mailbox_cursors WHERE recipient = $name), 0)
        )
      ORDER BY m.rowid DESC
      LIMIT 1
    `),

    /** Exact OOB delivery envelope selected by the structural cursor. This is
     * read-only and remains launch/session constrained in the dispatcher; the
     * caller must present both cursor and message id so a racing tail cannot
     * substitute a different payload. */
    getActionableAttentionDelivery: db.prepare(`
      SELECT rowid AS seq, id, type, sender, content, bead_id, ref,
             request, reply, ts
      FROM messages AS m
      WHERE m.recipient = $name
        AND m.kind = 'direct'
        AND m.sender != $name
        AND m.type IN (${ACTIONABLE_TYPES_SQL})
        AND ${unretiredAttentionPredicateSql("m")}
        AND m.rowid = $seq
        AND m.id = $id
        AND m.rowid > COALESCE((SELECT last_actionable_seq FROM mailbox_cursors WHERE recipient = $name), 0)
      LIMIT 1
    `),

    // Cleanup short-lived poll/event dedup entries. Launch takeover keys are
    // durable authority fences, not race-window suppression: expiring one
    // while an old adapter can still reconnect would let its inherited
    // takeover bit reclaim a deliberately superseded persona (21049).
    cleanupDedup: db.prepare("DELETE FROM dedup WHERE ts < $cutoff AND key NOT LIKE 'launch-takeover:%'"),

    /**
     * Explicit column lists on BOTH sides, so a column added to `messages`
     * without being added here is dropped on archival with no error — which is
     * exactly what happened to `attention_required` between v24 and v26. When
     * you add a column to `messages`, add it in three places: the CREATE, this
     * SELECT, and this INSERT.
     */
    archiveExpiredMessages: db.prepare(`
		INSERT OR IGNORE INTO messages_archive (
			seq, id, type, sender, recipient, kind, content, bead_id, ref, ts,
			delivery, topic, room_id, request, reply, correlated_reply_requester, summary, session_id,
			attention_required, archived_at
		)
		SELECT
			rowid, id, type, sender, recipient, kind, content, bead_id, ref, ts,
			delivery, topic, room_id, request, reply, correlated_reply_requester, summary, session_id,
			attention_required, $archived_at
		FROM messages
		WHERE ts < $cutoff
	`),

    deleteExpiredMessages: db.prepare("DELETE FROM messages WHERE ts < $cutoff"),

    updateLastDelivered: db.prepare(
      "UPDATE sessions SET last_delivered_ts = $ts, last_delivered_seq = $seq, updated_at = $ts WHERE id = $id",
    ),

    getLastDelivered: db.prepare("SELECT last_delivered_ts, last_delivered_seq FROM sessions WHERE id = $id"),

    getMessageTailSeq: db.prepare("SELECT COALESCE(MAX(rowid), 0) AS seq FROM messages"),

    resetSessionDeliveryOffsets: db.prepare(`
      UPDATE sessions
      SET
        last_delivered_ts = $ts,
        last_delivered_seq = $seq,
        last_inbox_pull_seq = $seq,
        updated_at = $ts
      WHERE id = $id
    `),

    // ---------------- km-tribe.event-classification ----------------

    /** Pull pending inbox rows for a session — push + pull rows whose rowid
     *  exceeds the session's pull cursor and whose recipient matches.
     *
     *  The session's stored subscription (`tribe.filter`) is applied HERE, in
     *  SQL, and this is the only place it can do any good: `shouldDeliver` in
     *  with-broadcast.ts gates the push wakeup, and 62 of 63 sessions are
     *  `delivery=pull`. Before this predicate existed, `@cto` had `mode: focus`
     *  persisted on a pull session and it removed nothing — accepted, stored,
     *  inert (NO SILENT ERRORS class).
     *
     *  It must be a predicate rather than a post-query filter so the cursor
     *  passes over excluded rows the same way it already passes over
     *  `kind = 'event'`. A row this seat unsubscribed from was never owed to it,
     *  so skipping it is not the message loss that 19785 rejected for the
     *  per-call `topics` snapshot — that one filters rows the seat IS owed. */
    getInboxRows: db.prepare(`
		SELECT m.id, m.rowid, m.type, m.sender, m.recipient, m.content, m.bead_id, m.ref, m.ts,
			m.delivery, m.topic, m.room_id, m.summary, m.attention_required
		FROM messages AS m
		WHERE m.rowid > $since
			AND (m.recipient = $name OR m.recipient = '*')
			AND m.kind != 'event'
			AND m.sender != $name
			AND (
				$filter_mode = 'ambient'
				-- Focus diets FLEET traffic, never your own mail. A row addressed
				-- to this seat by name stays fetchable in every mode: the point of
				-- the subscription is that not everyone needs to know everything,
				-- and a direct IS the right agent being told. Push may still skip
				-- the WAKEUP for a non-actionable direct (shouldDeliver's diet) —
				-- that is a different question from whether the row is delivered,
				-- and the two paths are meant to differ here.
				OR ($filter_mode = 'focus' AND (m.recipient = $name OR m.type IN (${ACTIONABLE_TYPES_SQL})))
				OR ($filter_mode = 'normal' AND (
					m.recipient = $name
					OR $filter_until IS NULL
					OR $filter_until <= $now
					OR (
						-- Malformed mute JSON falls through to "mute covers everything",
						-- matching safeJsonArray + the !muted branch of shouldDeliver.
						-- Without json_valid() SQLite would raise and take the whole
						-- drain down instead.
						json_valid(COALESCE($filter_mute, '[]'))
						AND json_array_length(COALESCE($filter_mute, '[]')) > 0
						AND (
							m.topic IS NULL
							OR NOT EXISTS (SELECT 1 FROM json_each($filter_mute) WHERE m.topic GLOB value)
						)
					)
				))
			)
			AND (
				NOT (m.recipient = $name AND m.kind = 'direct' AND (m.type IN (${ACTIONABLE_TYPES_SQL}) OR m.attention_required = 1))
				OR ${unretiredAttentionPredicateSql("m")}
			)
			AND NOT (
				m.recipient = $name
				AND m.kind = 'direct'
				AND (m.type IN (${ACTIONABLE_TYPES_SQL}) OR m.attention_required = 1)
				AND m.rowid <= COALESCE(
					(SELECT last_actionable_seq FROM mailbox_cursors WHERE recipient = $name),
					0
				)
			)
		ORDER BY m.rowid ASC
		LIMIT $limit
	`),

    /**
     * Highest rowid in the journal, read BEFORE the inbox window so it can only
     * be conservative — anything inserted afterwards is greater and is picked up
     * on the next drain.
     *
     * A subscribed-away seat can have an entire window excluded by the predicate
     * above, which returns zero rows and would leave the cursor parked while the
     * excluded tail grows without bound — re-scanned on every fetch. When the
     * window comes back short, the tail is exhausted and the cursor may safely
     * jump to here. This is the same hot path that once cost 590k page reads.
     */
    getMaxMessageRowid: db.prepare("SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM messages"),

    /** Advance the per-session pull cursor — never decreases. */
    advanceInboxCursor: db.prepare(
      "UPDATE sessions SET last_inbox_pull_seq = MAX(last_inbox_pull_seq, $seq), updated_at = $now WHERE id = $id",
    ),

    /** Read-only fetch of the per-session pull cursor. */
    getInboxCursor: db.prepare("SELECT last_inbox_pull_seq FROM sessions WHERE id = $id"),

    /**
     * Presence heartbeat (@km/tribe/19784): every authenticated tool call
     * touches the caller's row, so `last_seen` on tribe.members means
     * "process spoke to the daemon recently" — send-only and empty-drain
     * sessions no longer read as idle (the 2026-06-10 false-idle class).
     */
    touchSessionPresence: db.prepare("UPDATE sessions SET updated_at = $now WHERE id = $id"),

    /**
     * 19442 undead reframe — durable attention mailbox, keyed by recipient
     * NAME (not session). `last_actionable_seq` is the compatibility name for
     * the highest attention rowid acknowledged for the mailbox.
     * Rename/rejoin/takeover retain it, and recovery reads the attention-only
     * view below instead of rewinding any session's ambient pull cursor (the
     * old rewind replayed every intervening ambient broadcast — the 97-row
     * transcript flood).
     */
    getMailboxCursor: db.prepare("SELECT last_actionable_seq FROM mailbox_cursors WHERE recipient = $recipient"),

    /** Advance-only (MAX) upsert of a mailbox's acknowledged attention seq. */
    advanceMailboxCursor: db.prepare(`
      INSERT INTO mailbox_cursors (recipient, last_actionable_seq, updated_at)
      VALUES ($recipient, $seq, $now)
      ON CONFLICT(recipient) DO UPDATE SET
        last_actionable_seq = MAX(last_actionable_seq, $seq),
        updated_at = $now
    `),

    /** Record that the named mailbox owner received the canonical attention
     * projection. This receipt is independent of actionable acknowledgement:
     * empty reads and advance:false reads count, but never move the cursor. */
    touchMailboxAttentionRead: db.prepare(`
      INSERT INTO mailbox_cursors (recipient, last_actionable_seq, updated_at, last_attention_read_at)
      VALUES ($recipient, 0, $now, $now)
      ON CONFLICT(recipient) DO UPDATE SET
        last_attention_read_at = MAX(COALESCE(last_attention_read_at, 0), $now)
    `),

    /**
     * The attention-only recovery view (19442, 21757): unacknowledged DIRECT
     * attention rows addressed to a mailbox, oldest first. `$upto` bounds the
     * scan to rows the ambient window will NOT return (rowid <= the session's
     * pull cursor) so default-drain injection never duplicates a window row.
     * NO age horizon — recovery is lossless by design; only a mailbox-cursor
     * acknowledgement retires a row from this view.
     */
    selectUnackedAttention: db.prepare(`
      SELECT id, rowid, type, sender, recipient, content, bead_id, ref, ts, delivery, topic, room_id, summary,
             attention_required
      FROM messages AS m
      WHERE m.recipient = $name
        AND m.kind = 'direct'
        AND m.sender != $name
        AND (m.type IN (${ACTIONABLE_TYPES_SQL}) OR m.attention_required = 1)
        AND ${unretiredAttentionPredicateSql("m")}
        AND m.rowid > COALESCE((SELECT last_actionable_seq FROM mailbox_cursors WHERE recipient = $name), 0)
        AND m.rowid <= $upto
      ORDER BY m.rowid ASC
      LIMIT $limit
    `),

    /**
     * Read-only turn-attention view (17199, 21757): every unacknowledged
     * actionable direct plus newly classified direct response for the
     * recipient, independent of the ambient inbox window. The normal fetch
     * limit still bounds chronological `events`; this projection prevents a
     * later verdict/request/response from sitting behind that ambient page. It
     * reuses the recipient mailbox cursor — no second queue, cursor, or store.
     */
    selectAttention: db.prepare(`
      SELECT id, rowid, type, sender, recipient, content, bead_id, ref, ts, delivery, topic, room_id, summary,
             attention_required
      FROM messages AS m
      WHERE m.recipient = $name
        AND m.kind = 'direct'
        AND m.sender != $name
        AND (m.type IN (${ACTIONABLE_TYPES_SQL}) OR m.attention_required = 1)
        AND ${unretiredAttentionPredicateSql("m")}
        AND m.rowid > COALESCE((SELECT last_actionable_seq FROM mailbox_cursors WHERE recipient = $name), 0)
      ORDER BY m.rowid ASC
    `),

    /** Count-only form of the recovery view — join/rename recovery reporting. */
    countUnackedAttention: db.prepare(`
      SELECT COUNT(*) AS count
      FROM messages AS m
      WHERE m.recipient = $name
        AND m.kind = 'direct'
        AND m.sender != $name
        AND (m.type IN (${ACTIONABLE_TYPES_SQL}) OR m.attention_required = 1)
        AND ${unretiredAttentionPredicateSql("m")}
        AND m.rowid > COALESCE((SELECT last_actionable_seq FROM mailbox_cursors WHERE recipient = $name), 0)
    `),

    /**
     * Apply a session's filter — single update covering persistent mode +
     * time-bounded mute + per-topic glob list. Replaces the old
     * setSessionMode / setSessionSnooze pair.
     *
     * Pass any field as null to clear that dimension: `$until = null` makes the
     * filter persistent, `$mute = null` silences everything (when a snooze is
     * active), `$mode = 'normal'` returns to default behavior.
     */
    setSessionFilter: db.prepare(
      "UPDATE sessions SET filter_mode = $mode, filter_until = $until, filter_mute = $mute, updated_at = $now WHERE id = $id",
    ),

    /** Read the session's current filter (mode + optional until + optional muted topics). */
    getSessionFilter: db.prepare("SELECT filter_mode, filter_until, filter_mute FROM sessions WHERE id = $id"),
  }
}
