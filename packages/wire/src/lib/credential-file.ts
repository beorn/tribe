/**
 * The `_FILE` half of the credential contract (27314 B1, @cto c13452cd): a launch hands a process the PATH of a
 * 0600 file holding the value, never the value itself, so an unfiltered environment dump (env/printenv/set) carries
 * no secret. One reader for the file, in the bottom package both credentials' owners reach.
 *
 * A NAMED FILE THAT CANNOT BE READ IS NEVER "NO CREDENTIAL". An absent or empty variable is absence; a path that is
 * set but unreadable or empty is a mis-provisioned launch, and it fails loudly by path — silently falling back to
 * the value (or to "none") would be exactly the silent error the estate forbids.
 */
import { readFileSync } from "node:fs"

export function readCredentialFile(path: string | undefined): string | null {
  const trimmed = path?.trim() ?? ""
  if (trimmed === "") return null
  let bytes: string
  try {
    bytes = readFileSync(trimmed, "utf8")
  } catch (error) {
    throw new Error(
      `credential file ${trimmed} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const value = bytes.trim()
  if (value === "") throw new Error(`credential file ${trimmed} is empty`)
  return value
}
