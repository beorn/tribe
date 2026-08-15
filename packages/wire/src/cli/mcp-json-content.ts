/** Unwrap an MCP tool result's JSON text, preserving unparseable and raw values. */
export function mcpJsonContent(raw: unknown): unknown {
  const text = (raw as { content?: ReadonlyArray<{ text?: string }> })?.content?.[0]?.text
  if (typeof text === "string") {
    try {
      return JSON.parse(text)
    } catch {
      return raw
    }
  }
  return raw
}
