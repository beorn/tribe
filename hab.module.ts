export default {
  name: "tribe",
  services: {
    wire: {
      command: "bun vendor/tribe/packages/daemon/src/daemon.ts",
      env: { TRIBE_DELIVERY_FALLBACKS: '[{"prefix":"@dev/","to":"@dev"}]' },
      // oxfmt-ignore
      stateRoots: ["${TRIBE_DB:-${XDG_DATA_HOME:-$HOME/.local/share}/tribe/tribe.db}", "${TRIBE_SOCKET:-${XDG_RUNTIME_DIR:-$HOME/.local/share/tribe}/tribe.sock}"],
      health: { command: "tribe health" },
    },
  },
}
