import { connectToDaemon, resolveSocketPath, type DaemonClient } from "../lib/socket.ts"

/** Own the one-shot CLI connection lifecycle around a caller-specific action. */
export async function withCliDaemonClient<T>(action: (client: DaemonClient) => Promise<T>): Promise<T> {
  const socketPath = resolveSocketPath()
  try {
    const client = await connectToDaemon(socketPath)
    try {
      return await action(client)
    } finally {
      client.close()
    }
  } catch (error) {
    const code = (error as { code?: string | number }).code
    if (code === "ECONNREFUSED" || code === "ENOENT") {
      console.error(`No daemon running (socket: ${socketPath})`)
      console.error("Start one with: bun tribe-daemon (package tribe-daemon), or let a host autostart it")
      process.exit(1)
    }
    throw error
  }
}
