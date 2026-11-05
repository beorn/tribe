/**
 * The vault semantic census (AC1) as `recall status` reads and prints it (@ag/recall/three-dark-search-paths).
 *
 * The leg's module loads only here, when a vault is bound, so no other recall command loads it or qmd's llm.js. A
 * census that fails is a reading with its cause, on the text path as on the JSON path (CTO r2 change 5), never a
 * FATAL after partial output.
 */
import type { Database } from "bun:sqlite"
import type { VaultSemanticCensus } from "../history/vault-semantic.ts"
import { BOLD, CHECK, DIM, RESET, WARN } from "./format"

export type VaultSemanticCensusReading = VaultSemanticCensus | { readonly error: string }

export async function readVaultSemanticCensus(db: Database, vaultDbPath: string): Promise<VaultSemanticCensusReading> {
  try {
    const { vaultSemanticCensus } = await import("../history/vault-semantic.ts")
    return vaultSemanticCensus(db, vaultDbPath)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** The text block: the check mark means no cause, so a vault that is not queryable never shows one. */
export function vaultSemanticCensusLines(reading: VaultSemanticCensusReading): string[] {
  const lines = [`${BOLD}Vault Semantic${RESET}`]
  if ("error" in reading) {
    lines.push(`  ${WARN} census failed: ${reading.error}`)
    return lines
  }
  const mark = reading.cause === undefined ? CHECK : WARN
  lines.push(
    `  ${mark} ${reading.queryable}/${reading.units} documents queryable; ${reading.accepted} embedded under generation ${reading.generation ?? "none"}`,
  )
  for (const [reason, count] of Object.entries(reading.excluded)) {
    lines.push(`  ${DIM}  ${count} excluded: ${reason}${RESET}`)
  }
  if (reading.cause !== undefined) lines.push(`  ${WARN} not queryable: ${reading.cause}`)
  return lines
}
