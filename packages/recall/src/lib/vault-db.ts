/**
 * The one `--vault-db` rule (25149). The recall CLI, the daemon's launch line and the `tribe hook` line all carry
 * the km vault database this way, and all three call this function, so the refusals cannot drift apart.
 *
 * Absent is unbound. An empty or valueless flag is what a failed `$(…)` substitution passes, and a path naming no
 * file is a stale line; both refuse, naming the fault, instead of reading as unbound or failing later at the first
 * search. A present path is returned absolute, so logs name the file the engine opens.
 *
 * Kept free of engine imports: the daemon and the hook line call it on their startup path.
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"

export function resolveVaultDbFlag(raw: string, exists?: (path: string) => boolean): string
export function resolveVaultDbFlag(raw: string | boolean | undefined, exists?: (path: string) => boolean): string | null
export function resolveVaultDbFlag(
  raw: string | boolean | undefined,
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (raw === undefined) return null
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("--vault-db is empty (a failed substitution?); pass the vault's state.db path")
  }
  const path = resolve(raw)
  if (!exists(path)) throw new Error(`--vault-db ${path} does not exist; pass the vault's state.db path`)
  return path
}
