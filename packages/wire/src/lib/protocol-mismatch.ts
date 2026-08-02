/**
 * Format the daemon's actionable protocol mismatch refusal.
 *
 * Restart re-execs the same pinned module root; it cannot repair a version
 * mismatch by itself. The remedy must advance the side serving the old root.
 */
export function protocolVersionMismatchMessage(
  clientVersions: readonly number[],
  daemonVersions: readonly number[],
): string {
  const clientLabel = clientVersions.length > 0 ? clientVersions.join(",") : "unknown"
  const daemonLabel = daemonVersions.join(",")
  const clientNewest = clientVersions[0]
  const daemonNewest = daemonVersions[0]
  const action =
    clientNewest !== undefined && daemonNewest !== undefined && clientNewest < daemonNewest
      ? `Upgrade the Tribe client module root to v${daemonVersions.at(-1)} or newer; restarting will not help because it re-execs the same pinned module root.`
      : `Advance the Tribe daemon module root to v${clientNewest ?? daemonNewest} or newer; restarting will not help because it re-execs the same pinned module root.`
  return `Protocol version mismatch: client=${clientLabel}; daemon=${daemonNewest ?? "unknown"}; supported=${daemonLabel}. ${action}`
}
