/**
 * 29327 - the marker a settled ball's still-unread row carries into a pane.
 *
 * The daemon decides `settled` from the tracker and names the settler only
 * when its own settlement record has one. The pane envelope used to drop both
 * fields and present the raw body, so a request settled seconds after it was
 * queued still read as owed work. The marker is content, because the pane
 * renders content and no envelope attribute.
 */
export function settledMarker(event: { settled?: boolean; settled_by?: string }): string {
  if (event.settled !== true) return ""
  const settler = typeof event.settled_by === "string" && event.settled_by.length > 0 ? ` by ${event.settled_by}` : ""
  return `[settled${settler} — not owed] `
}
