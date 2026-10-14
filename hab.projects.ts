export default {
  name: "tribe",
  habitants: {
    wire: {
      owner: "@chief",
      // --idle-quit-after never: this daemon never stops itself. Set 2026-08-11
      // (as `--quit-timeout -1`; flag renamed 2026-08-12, old name still parses).
      //
      // The 1800s default took the whole fleet's coordination rail down. Every client disconnects
      // at once during a seat-relaunch sweep — routine here, and indistinguishable from idleness
      // from inside the daemon. hab then counts each clean exit as a service FAILURE, so a few
      // idle windows exhausted wire's restart budget and suppressed the service outright: an
      // on-demand convenience became an outage no restart could clear.
      //
      // A long timeout was the first fix and it was reasoning from a hazard that does not exist.
      // The worry was an ORPHANED daemon outliving an ungraceful teardown, holding the socket and
      // rejecting every replacement (a starting daemon defers to the incumbent and exits). But hab
      // attaches a REAPER to each service — `cat >/dev/null` blocking on stdin, then
      // `kill -TERM -$pgid` — a dead-man's switch that fires when the supervisor dies, gracefully
      // or not. Orphans are already handled, so idle-quit buys nothing here and only risks the
      // outage above.
      //
      // ON THE COMMAND LINE, not env: co-located with what it configures, and visible in `ps`, so
      // a running daemon's actual value is readable from outside it. The equivalent env var sat
      // unwired for hours and nothing could see that. Belt-and-braces: the daemon also defaults
      // to `never` on its own whenever HAB_SERVICE_NAME is present and no explicit knob is set.
      command: "bun vendor/tribe/packages/daemon/src/daemon.ts --idle-quit-after never",
      // 29271 (@cto b118aa8e): wire owns its structured log at the daemon's date-stamped activity stream. The
      // directory is the one the daemon's own writer derives (`activityLogDir`, wire/src/activity-log-contract.ts:
      // `<HOME>/.local/share/tribe`), written here as the same `$HOME` reference rather than that module's code: a
      // Hab config module is PURE and may not import executable code or read the ambient process. The `*` keeps a plan
      // evaluated today from freezing on today's file, and `hab log wire` resolves the newest match by mtime. The
      // daemon's own `TRIBE_ACTIVITY_LOG=<path>|off` override is a test/dev escape and is not reflected here.
      log: "$HOME/.local/share/tribe/activity-*.jsonl",
      env: {
        TRIBE_DELIVERY_FALLBACKS:
          '[{"name":"@fleet","to":"@chief","action":"refuse"},{"name":"@ci","to":"@chief"},{"name":"@yrd","to":"@chief","action":"refuse"},{"name":"@fable/0","to":"@chief","action":"refuse"},{"name":"@fable/1","to":"@chief","action":"refuse"}]',
      },
      // oxfmt-ignore
      stateRoots: ["${TRIBE_DB:-${XDG_DATA_HOME:-$HOME/.local/share}/tribe/tribe.db}", "${TRIBE_SOCKET:-${XDG_RUNTIME_DIR:-$HOME/.local/share/tribe}/tribe.sock}"],
      // 27871 AC2: DECLARE wire's own probe budget so hab's bound outlasts it. The CLI gives its client a 10 s connect
      // deadline and a 10 s per-call deadline (client.ts, `callTimeoutMs`), so a loaded or half-open socket can take
      // ~20 s before `tribe health --json` prints its OWN hab-service-health/2 document and exits. At hab's 15 s
      // default the probe was killed first, so the reader saw hab's kill (or, on the exit path before 27871 AC1,
      // nothing at all) instead of wire's own answer. 25 s covers the CLI's worst case with headroom; a bound at or
      // above `intervalMs` is refused, and wire declares no interval.
      health: { command: "tribe health --json", timeoutMs: 25_000 },
      // It runs from an immutable landing; the hab controller restarts it onto the promoted landing (26774,
      // @cto 9e7a89d2).
      // 28691 (one-version plan slice 1.1, @cto Q5): the closure-digest skip is RETIRED — wire restarts on EVERY
      // promotion. The digest and the declared-pin comparison are both COMPONENT checks, and the week's two
      // misses were undeclared dependencies (wire's spawned hab, its argv-named verifier), so "the release is
      // the unit" means restart whenever the running release differs from current. 28921 (@cto c97b1bf3):
      // identical compared pins coalesce — the owed restart waits up to 2 h for a newer landing to ride, never
      // skipped — and hab's own pin joins the compared set below as `ag`, the gitlink wire spawns hab from.
      // 27422: bearly and loggily load in process; the sdk escapes are install bytes the /3 install scope covers.
      landingMigration: {
        mechanism: "restart-at-promotion" as const,
        additionalComponents: ["vendor/bearly", "vendor/loggily", "ag"] as const,
      },
    },
  },
}
