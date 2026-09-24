/**
 * The one incident page for a refused recall vault (25149, @cto 405805a7).
 *
 * The bus outranks the vault: when `--vault-db` names no file, the daemon boots anyway and pages @chief once,
 * as an incident (emitter wire, subject vault-db, condition missing), so a restart loop upserts one ball instead
 * of stacking pages. A later boot that finds the file clears that incident. A boot with nothing open sends
 * nothing, so an ordinary restart never pages.
 */

import { incidentKey, type IncidentIdentity } from "tribe-wire"
import type { TribeContext } from "./context.ts"
import { sendMessage } from "./messaging.ts"

export const VAULT_DB_INCIDENT: IncidentIdentity = { emitter: "wire", subject: "vault-db", condition: "missing" }

export function pageVaultDbRefusal(
  ctx: TribeContext,
  refusal: { readonly path: string; readonly reason: string } | null,
): void {
  if (refusal) {
    sendMessage(
      ctx,
      "@chief",
      `wire booted with the recall vault REFUSED: --vault-db ${refusal.reason}. The bus is up; every recall call that needs the vault refuses until a restart finds the file.`,
      "notify",
      undefined,
      undefined,
      "direct",
      {},
      { incident: { ...VAULT_DB_INCIDENT, active: true } },
    )
    return
  }
  const open = ctx.stmts.selectPendingSettlementsForRequest.all({ $request_id: incidentKey(VAULT_DB_INCIDENT) })
  if (open.length === 0) return
  sendMessage(
    ctx,
    "@chief",
    "wire booted with its recall vault present again; the vault-db incident is cleared.",
    "notify",
    undefined,
    undefined,
    "direct",
    {},
    { incident: { ...VAULT_DB_INCIDENT, active: false } },
  )
}
