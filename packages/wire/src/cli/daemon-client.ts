import { connectToDaemon, resolveSocketPath, type ConnectToDaemonOpts, type DaemonClient } from "../lib/socket.ts"

/**
 * Own the one-shot CLI connection lifecycle around a caller-specific action.
 *
 * `connectOpts` reaches `connectToDaemon` unchanged, so a verb whose answer is a PRESENCE decision can opt out of
 * the 28674 restart-retry window with `{ connectRetryWindowMs: 0 }` and describe the socket now. Verbs that bridge
 * a restart leave it off and take the default window.
 */
export async function withCliDaemonClient<T>(
  action: (client: DaemonClient) => Promise<T>,
  missingDaemon: "exit" | "throw" = "exit",
  connectOpts?: ConnectToDaemonOpts,
): Promise<T> {
  const socketPath = resolveSocketPath()
  try {
    const client = await connectToDaemon(socketPath, connectOpts)
    try {
      return await action(client)
    } finally {
      client.close()
    }
  } catch (error) {
    const code = (error as { code?: string | number }).code
    if (code === "ECONNREFUSED" || code === "ENOENT") {
      // Diagnostic callers must finish their own report, including checks
      // collected before connecting. Other verbs retain the ordinary error UX.
      if (missingDaemon === "throw") {
        throw new Error(
          `No daemon running (socket: ${socketPath}, ${code}). Start the daemon or let a host autostart it.`,
          { cause: error },
        )
      }
      console.error(`No daemon running (socket: ${socketPath})`)
      console.error(
        "Start one with: bun packages/daemon/src/daemon.ts (from the repo root), or let a host autostart it",
      )
      process.exit(1)
    }
    throw error
  }
}
