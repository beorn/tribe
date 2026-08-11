export default {
  name: "tribe",
  services: {
    wire: {
      command: "bun vendor/tribe/packages/daemon/src/daemon.ts",
      // TRIBE_QUIT_TIMEOUT=-1 disables idle auto-quit (with-idle-quit.ts: -1 never fires the timer,
      // 0 quits immediately). Set 2026-08-11 after idle-quit took the whole fleet's coordination
      // rail down: the daemon logged "No clients connected. Auto-quit in 1800s" at 10:07 while
      // seats were being relaunched — every client disconnected at once, which is routine here and
      // looks exactly like idleness from inside the daemon.
      //
      // The auto-quit alone would be survivable; the INTERACTION is not. hab counts each exit as a
      // service failure, so a handful of idle windows exhausted wire's restart budget and
      // suppressed it — "restarts suppressed until 17:25 (5 failures)" — turning a benign
      // on-demand behaviour into a permanent outage that no restart could clear.
      //
      // Auto-quit is right for a single-user on-demand CLI. This is a persistent multi-seat fleet
      // where the daemon is never legitimately idle, and nothing here does socket activation, so
      // "let it quit and come back on demand" has no mechanism to come back.
      env: { TRIBE_DELIVERY_FALLBACKS: '[{"prefix":"@dev/","to":"@dev"}]', TRIBE_QUIT_TIMEOUT: "-1" },
      // oxfmt-ignore
      stateRoots: ["${TRIBE_DB:-${XDG_DATA_HOME:-$HOME/.local/share}/tribe/tribe.db}", "${TRIBE_SOCKET:-${XDG_RUNTIME_DIR:-$HOME/.local/share/tribe}/tribe.sock}"],
      health: { command: "tribe health" },
    },
  },
}
