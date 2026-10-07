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
      // It runs from an immutable landing; when a promoted landing carries a new vendor/tribe, the hab
      // controller restarts it onto that landing (26774, @cto 9e7a89d2). A km-only landing leaves it running.
      // With sourceDigest it does so only when the daemon's closure changed: a tribe move touching nothing it
      // loads keeps it, and every connected seat's call, running (27085, @cto 5d9ac8bc).
      // 27422 (@cto 198c1ee0): the daemon loads bearly and loggily in process from the landing root, so both sibling
      // gitlinks are declared; the @modelcontextprotocol/sdk escapes are hoisted install bytes the /3 install scope
      // covers instead.
      landingMigration: {
        mechanism: "restart-at-promotion" as const,
        additionalComponents: ["vendor/bearly", "vendor/loggily"] as const,
      },
      sourceDigest: "bun-closure" as const,
    },
  },
}
