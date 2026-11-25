/**
 * The lines an index run prints about where it read transcripts (#38420, @cto 96afab5d).
 *
 * A thin index answer must name what it read and what it could not: each claude root with its file count, each root
 * it did not read with the reason, each declared seat whose profile is missing by name, and the provider roots ag
 * never named. Silence here reads as "nothing was ever recorded", which is the bug this row was filed for.
 */
import type { IndexResult } from "../history/indexer.ts"

export function indexRootsReport(result: IndexResult): string[] {
  const lines: string[] = []
  for (const failure of result.profileRootFailures ?? []) {
    lines.push(`  (ag did not name ${failure.provider} profile roots: ${failure.reason})`)
  }
  const roots = result.claudeRoots ?? []
  if (roots.length > 0) {
    const read = roots.filter((root) => root.readable)
    const files = read.reduce((sum, root) => sum + root.files, 0)
    lines.push(
      `  Claude roots: ${read.length} read (${files.toLocaleString()} files), ${roots.length - read.length} not read`,
    )
    for (const root of roots) {
      lines.push(
        `    - ${root.root}: ${root.readable ? `${root.files.toLocaleString()} files` : `not read (${root.reason ?? "unknown"})`}`,
      )
    }
  }
  const seats = result.seatProfiles
  if (seats === undefined) return lines
  if (seats.failure !== undefined) {
    lines.push(
      `  (habitat plan ${seats.source ?? "?"} could not be read: ${seats.failure}; no declared seat was checked)`,
    )
    return lines
  }
  if (seats.source === null) return lines
  lines.push(
    `  Declared seats: ${seats.declared.toLocaleString()} in ${seats.source}; ` +
      (seats.checked === 0
        ? "no provider profile was checked (see the line above for why)"
        : `${seats.checked.toLocaleString()} checked against ag's profile roots, ` +
          (seats.unreadable.length === 0 ? "all readable" : `${seats.unreadable.length} without a readable profile`)),
  )
  for (const seat of seats.unreadable) {
    lines.push(`    - ${seat.seat} (${seat.provider}, ${seat.account}): ${seat.reason}`)
  }
  return lines
}
