export default {
  name: "tribe",
  services: {
    wire: {
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
      env: { TRIBE_DELIVERY_FALLBACKS: '[{"prefix":"@dev/","to":"@dev"}]' },
      // oxfmt-ignore
      stateRoots: ["${TRIBE_DB:-${XDG_DATA_HOME:-$HOME/.local/share}/tribe/tribe.db}", "${TRIBE_SOCKET:-${XDG_RUNTIME_DIR:-$HOME/.local/share/tribe}/tribe.sock}"],
      health: { command: "tribe health" },
    },
  },
}
