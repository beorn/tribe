/** Write one complete machine-readable JSON document or fail the CLI loudly. */
export async function writeJsonStdout(value: unknown, space?: number): Promise<void> {
  try {
    const json = JSON.stringify(value, null, space)
    if (json === undefined) throw new Error("value is not JSON-serializable")
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        // Bun can report the same failed write first through end's callback and
        // then through the stream's error event. Keep the listener armed after
        // a failure so the second report cannot become an uncaught exception.
        if (!error) process.stdout.off("error", onError)
        if (error) reject(error)
        else resolve()
      }
      const onError = (error: Error): void => finish(error)
      process.stdout.on("error", onError)
      try {
        process.stdout.end(`${json}\n`, (error?: Error | null) => finish(error ?? undefined))
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`tribe-wire: failed to write complete JSON payload to stdout: ${detail}`)
    process.exitCode = 1
  }
}
