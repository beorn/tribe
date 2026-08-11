export default {
  name: "tribe",
  services: {
    wire: {
      command: "bun vendor/tribe/packages/daemon/src/daemon.ts",
      // Idle auto-quit raised 1800s -> 6h, 2026-08-11. NOT disabled (-1), deliberately.
      //
      // What went wrong at 1800s: the daemon logged "No clients connected. Auto-quit in 1800s" at
      // 10:07 while seats were being relaunched. Every client disconnecting at once is routine in a
      // supervised fleet and is indistinguishable from real idleness from inside the daemon. The
      // auto-quit alone would be survivable; the INTERACTION is not — hab counts each exit as a
      // service failure, so a few idle windows exhausted wire's restart budget and suppressed it
      // ("restarts suppressed until 17:25, 5 failures"), turning an on-demand convenience into an
      // outage no restart could clear.
      //
      // Why NOT -1, which was the first instinct and is wrong: idle-quit is the ONLY automatic
      // recovery from an orphaned daemon. A starting daemon does not take over — it logs "Another
      // daemon is already listening on <socket>, exiting" and defers to the incumbent. So a daemon
      // that outlives an ungraceful hab teardown holds the socket and REJECTS EVERY REPLACEMENT,
      // including one carrying a fix. At -1 that state is permanent and needs a human with a kill.
      // Graceful `hab down` reaps wire by process group, so this only bites on abnormal death —
      // which is exactly when nobody is watching.
      //
      // 6h is chosen against the two failure modes, not as a round number: far longer than any
      // relaunch sweep (minutes), short enough that an orphan self-clears within a working day.
      env: { TRIBE_DELIVERY_FALLBACKS: '[{"prefix":"@dev/","to":"@dev"}]', TRIBE_AUTOQUIT_ON_IDLE: "21600" },
      // oxfmt-ignore
      stateRoots: ["${TRIBE_DB:-${XDG_DATA_HOME:-$HOME/.local/share}/tribe/tribe.db}", "${TRIBE_SOCKET:-${XDG_RUNTIME_DIR:-$HOME/.local/share/tribe}/tribe.sock}"],
      health: { command: "tribe health" },
    },
  },
}
