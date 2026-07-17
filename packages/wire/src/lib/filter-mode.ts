export type SessionFilterMode = "focus" | "normal" | "ambient"

export function initialFilterModeFromEnv(raw: string | undefined): SessionFilterMode | undefined {
  const mode = raw?.trim()
  if (!mode) return undefined
  if (mode === "focus" || mode === "normal" || mode === "ambient") return mode
  throw new Error(`Invalid TRIBE_FILTER_MODE=${JSON.stringify(raw)}; expected focus|normal|ambient`)
}
