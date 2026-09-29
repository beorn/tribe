/** A managed daemon's terminal refusal of an addressable persona without usable launch proof. */
export function isIdentityTokenMissingRefusal(
  error: unknown,
): error is Error & { readonly code: number; readonly data: { readonly kind: "identity-token-missing" } } {
  const candidate = error as { code?: unknown; data?: unknown } | null
  const data = candidate?.data
  return (
    typeof candidate?.code === "number" &&
    typeof data === "object" &&
    data !== null &&
    (data as { kind?: unknown }).kind === "identity-token-missing"
  )
}
