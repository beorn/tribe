/**
 * The one `--vault-db` rule (25149). The recall CLI, the daemon's launch line and the `tribe hook` line all carry
 * the km vault database this way, and all three call this rule, so the refusals cannot drift apart.
 *
 * Absent is unbound. An empty or valueless flag is what a failed `$(…)` substitution passes: the line itself is
 * broken, so it throws. A path naming no file is a stale line; {@link classifyVaultDbFlag} returns that refusal
 * and each surface maps it to its own documented behaviour (the CLI and the hook exit; the daemon, the bus, boots
 * with the vault refused — @cto 405805a7). A present path is returned absolute, so logs name the file the engine
 * opens.
 *
 * Kept free of engine imports: the daemon and the hook line call it on their startup path.
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"

export type VaultDbFlag =
  | { readonly state: "unbound" }
  | { readonly state: "bound"; readonly path: string }
  | { readonly state: "refused"; readonly path: string; readonly reason: string }

/** Classify a `--vault-db` value. Throws only for an empty or valueless flag. */
export function classifyVaultDbFlag(
  raw: string | boolean | undefined,
  exists: (path: string) => boolean = existsSync,
): VaultDbFlag {
  if (raw === undefined) return { state: "unbound" }
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("--vault-db is empty (a failed substitution?); pass the vault's state.db path")
  }
  const path = resolve(raw)
  if (!exists(path)) {
    return { state: "refused", path, reason: `${path} does not exist (pass the vault's state.db path)` }
  }
  return { state: "bound", path }
}

/** The rule for surfaces that stop on any refusal: a missing file throws, naming it. */
export function resolveVaultDbFlag(raw: string, exists?: (path: string) => boolean): string
export function resolveVaultDbFlag(raw: string | boolean | undefined, exists?: (path: string) => boolean): string | null
export function resolveVaultDbFlag(
  raw: string | boolean | undefined,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const flag = classifyVaultDbFlag(raw, exists)
  if (flag.state === "refused") throw new Error(`--vault-db ${flag.reason}`)
  return flag.state === "bound" ? flag.path : null
}
