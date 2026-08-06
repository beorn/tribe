export default {
  name: "tribe",
  services: {
    wire: {
      command: "bun vendor/tribe/packages/daemon/src/daemon.ts",
      env: { TRIBE_DELIVERY_FALLBACKS: '[{"prefix":"@dev/","to":"@dev"}]' },
      health: { command: "tribe health" },
      // INTERIM PIN, 2026-08-06 — remove when the ratified `declined` StopReason lands.
      //
      // Without this the row inherits `restart: always`, and the daemon exits 0
      // ("Another daemon is already listening on the socket, exiting") whenever it
      // loses the socket race. `always` restarts a CLEAN exit, so the loser
      // re-enters the race forever: measured restartCount 3088 with an EMPTY
      // failureHistory — three thousand restarts of a process that never once
      // failed. It burned a full core twice in one day, 83 minutes then 77, and
      // `hab sv stop` cleared it both times without sticking.
      //
      // `on-failure` is the surgical interim precisely BECAUSE the decline exits 0:
      // a genuine crash still restarts, a correct refusal does not. This is a pin,
      // not the fix — the real answer is a StopReason the supervisor can read
      // (@ag/hab/22834, and @adhoc/0's format proposal ratified by @cto), after
      // which a declined stop is never restarted whatever the policy says.
      restart: "on-failure",
    },
  },
}
