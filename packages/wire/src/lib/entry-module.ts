import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * Whether the module at `moduleUrl` is the process's entry, the file argv[1] names: a CLI or daemon module runs only
 * then, never on import (hh #26691, @cto 2259658a). The same guard as mdspec's src/index.ts isDirectRun, its
 * reference. An argv[1] that is not a readable path (bun --eval's arguments, say) is not this module's entry.
 */
export function isEntryModule(moduleUrl: string): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === fileURLToPath(moduleUrl)
  } catch {
    return false
  }
}
