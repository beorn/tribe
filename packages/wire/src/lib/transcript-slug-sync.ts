/**
 * Transcript `/rename` slug sync for the stdio adapter.
 *
 * When Claude's transcript slug changes, the adapter asks the daemon to rename the session to it. The adapter cannot
 * know whether its session is verified (the register answer carries no verdict), and a verified session's rename to a
 * slug is refused (wire-rename-refuse, @cto 5d2291ef item c). So the call stays, but nothing is swallowed: a refusal or
 * an error answer is logged at warn once per slug with the daemon's text, and the session counts as renamed only when
 * the daemon answers with the new name.
 */

export interface TranscriptSlugSyncDeps {
  /** The transcript's current slug, or null when there is none. */
  readonly readSlug: () => string | null
  /** The session's current tribe name. */
  readonly currentName: () => string
  /** Calls tribe.rename and returns the parsed tool answer. A JSON-RPC refusal rejects. */
  readonly rename: (slug: string) => Promise<{ readonly name?: string; readonly error?: string }>
  /** Called once with the daemon's name when the rename was applied. */
  readonly onRenamed: (name: string) => void
  readonly warn: (message: string) => void
}

/** Returns one tick of the sync; the adapter runs it on an interval. Each distinct slug is tried once. */
export function createTranscriptSlugSync(deps: TranscriptSlugSyncDeps): () => void {
  let lastSlug: string | null = null
  return () => {
    const slug = deps.readSlug()
    if (!slug || slug === lastSlug || slug === deps.currentName()) return
    lastSlug = slug
    void (async () => {
      try {
        const answer = await deps.rename(slug)
        if (answer.name) {
          deps.onRenamed(answer.name)
          return
        }
        deps.warn(
          `tribe.rename to transcript slug "${slug}" was not applied: ${answer.error ?? "the daemon answered without a name"}`,
        )
      } catch (error: unknown) {
        deps.warn(
          `tribe.rename to transcript slug "${slug}" was refused: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })()
  }
}
