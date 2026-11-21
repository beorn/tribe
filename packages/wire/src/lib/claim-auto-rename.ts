/**
 * Auto-rename on claim for the stdio adapter (34204).
 *
 * When a session still carries its generated `km-N-XXX` name and a `bead:claimed` row names this very session, the
 * adapter takes the bead's scope as the session name — once. The daemon may refuse (a name that is taken, or a
 * verified seat's name that may not move), and the older code swallowed both the refusal and an unparseable answer:
 * a seat then sat under a name the daemon had rejected with no trace anywhere.
 *
 * Nothing here swallows. A rejection, an error answer, an answer with no name, and an answer that cannot be parsed
 * all reach `warn` with BOTH identities — the scope asked for and the name the seat still holds — plus the daemon's
 * own words. The rename is attempted at most once per session, as before.
 */

export interface ClaimAutoRenameAnswer {
  /** The name the daemon applied. */
  readonly name?: string
  /** The daemon's refusal, verbatim. */
  readonly error?: string
}

export interface ClaimAutoRenameOptions {
  /** The name this session holds now; read on every claim, because an explicit /rename may have moved it. */
  readonly currentName: () => string
  /** This session's harness id, matched against the claim row's `[by:claude:<prefix>]` marker. */
  readonly sessionId: () => string | undefined
  /** Ask the daemon to rename. Resolves with the daemon's answer; rejects when the call itself fails. */
  readonly rename: (scope: string) => Promise<ClaimAutoRenameAnswer>
  /** Called with the daemon's name once the rename was applied. */
  readonly onRenamed: (name: string) => void
  readonly warn: (message: string) => void
  /** True once this adapter already renamed (an explicit /rename slug), so a claim never renames twice. */
  readonly renamed: () => boolean
  readonly markRenamed: () => void
}

const GENERATED_NAME = /^km-\d+-[a-z0-9]{3}$/
const CLAIM_BY_MARKER = /\[by:claude:([a-f0-9]+)\]/
const CLAIMED_BEAD = /^Claimed: (km-[a-z][\w-]*?)\./

export function createClaimAutoRename(options: ClaimAutoRenameOptions): (content: string) => void {
  return (content: string): void => {
    if (options.renamed()) return
    const current = options.currentName()
    // Only auto-rename while the session still carries its generated name (km-N-XXX).
    if (!GENERATED_NAME.test(current)) return
    const byMatch = content.match(CLAIM_BY_MARKER)
    const claimSessionPrefix = byMatch?.[1]
    if (claimSessionPrefix === undefined) return
    const sessionId = options.sessionId()
    if (sessionId === undefined || !sessionId.startsWith(claimSessionPrefix)) return
    // Extract the bead scope from "Claimed: km-<scope>.<suffix> - ..."
    const beadMatch = content.match(CLAIMED_BEAD)
    const scope = beadMatch?.[1]
    if (scope === undefined || scope === current) return
    options.markRenamed()
    const requested = 'requested "' + scope + '", verified "' + current + '"'
    void options.rename(scope).then(
      (answer) => {
        if (answer.error !== undefined) {
          options.warn("auto-rename refused: " + requested + ": " + answer.error)
          return undefined
        }
        if (answer.name === undefined) {
          options.warn("auto-rename answered without a name: " + requested)
          return undefined
        }
        options.onRenamed(answer.name)
        return undefined
      },
      (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        options.warn("auto-rename failed: " + requested + ": " + reason)
        return undefined
      },
    )
  }
}
