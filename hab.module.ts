export default {
  name: "tribe",
  source: import.meta.url,
  services: {
    wire: {
      command: "bun vendor/tribe/packages/daemon/src/daemon.ts",
      restart: "always" as const,
      env: { TRIBE_DELIVERY_FALLBACKS: '[{"prefix":"@dev/","to":"@dev"}]' },
      health: { command: "tribe health" },
    },
  },
}
