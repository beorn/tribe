/**
 * The warning a managed seat gets when the daemon reports its own tribe
 * transport is not connected (G9 P0 row 7).
 *
 * A seat's tribe adapter can die while the seat keeps working: one-shot CLI
 * calls still authenticate through launch authority, so sends and inbox reads
 * keep succeeding while nothing is pushed to it. The launch-scoped inbox read
 * (cli_inbox_status_by_launch_v1) carries `transport_state` only in that case,
 * and inbox-status and send both print this one line from it.
 */
export function warnIfSelfTransportDown(
  command: string,
  status: {
    readonly session?: unknown
    readonly launch_id?: unknown
    readonly transport_state?: unknown
    readonly transport_reason?: unknown
  },
): void {
  if (status.transport_state === undefined) return
  console.error(
    `tribe ${command}: WARNING — this seat's tribe transport is ${String(status.transport_state)} ` +
      `(session ${String(status.session)}, launch ${String(status.launch_id)}, ${String(status.transport_reason)}). ` +
      "Nothing is pushed to it and its inbox counts may be stale. " +
      "Cure: ask @chief to relaunch this seat, or reconnect its tribe MCP server with /mcp.",
  )
}
