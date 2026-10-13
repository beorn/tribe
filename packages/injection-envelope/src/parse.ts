/**
 * Parser for the envelope the chokepoint emits (28904).
 *
 * Consumers that need to READ injected context — the chat-UI notification row,
 * the notification classifier, the recall session eval — used to regex the raw
 * string for the old `<recall-memory>` / `<snippet>` markup by hand. That left
 * each of them coupled to the exact wrapper spelling: when recall's hook path
 * moved onto `wrapInjectedContext`, every one of them silently matched nothing.
 *
 * This is the ONE reader. It parses whatever the chokepoint emits —
 * `<injected_context source="…" mode="…" …>` wrapping zero or more
 * `<item …>body</item>` units — and a consumer keys on `source` / `mode` /
 * item attributes instead of the tag spelling.
 *
 * Robustness properties the consumers rely on:
 *   - Opening tags are scanned QUOTE-AWARE, so an attribute value containing
 *     `>` (`title="x > y"`) does not truncate the tag (the `[^>]*` bug the
 *     28904 review caught).
 *   - The pre-chokepoint shape is read too, as a `source="recall"` envelope:
 *     the historical producer emitted an `<injected_context source="recall">`
 *     WRAPPING `<vault-notice>` and/or `<recall-memory><snippet …></recall-memory>`
 *     (frozen producer e77dc660^), and a bare legacy block appears in older
 *     transcripts. Its nested units are attached to their CONTAINING recall
 *     envelope (never appended as a second, empty one), so a saved
 *     notification row keeps rendering instead of showing raw markup.
 */

import { INJECTION_ENVELOPE_TAG, INJECTION_ITEM_TAG } from "./tags.ts"

/** One framed unit read back out of an envelope. */
export interface ParsedInjectedItem {
  readonly id?: string
  readonly title?: string
  readonly path?: string
  readonly date?: string
  readonly type?: string
  readonly session?: string
  /** The item body — trimmed, but otherwise verbatim as emitted. */
  readonly body: string
}

/** One envelope (modern or legacy) read back out of a turn's text. */
export interface ParsedInjectedContext {
  /** The envelope's `source` attribute (e.g. `recall`, `tribe`). "" when absent. */
  readonly source: string
  /** The envelope's `mode` attribute (`snippet` | `pointer`). "" when absent. */
  readonly mode: string
  /** Every attribute on the open tag, values unescaped. */
  readonly attrs: Readonly<Record<string, string>>
  /** The framed items, in document order. */
  readonly items: readonly ParsedInjectedItem[]
}

/**
 * Attribute matcher: `key="value"` with JSON-escaped quotes tolerated, plus
 * bare `key=value` and single-quoted forms. The emitter writes values with
 * `JSON.stringify`, so `[^"]*` alone would stop at an escaped quote.
 */
const ATTR_RE = /([a-zA-Z_][\w-]*)=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))/g

const VAULT_NOTICE_TAG = "vault-notice"
const LEGACY_RECALL_TAG = "recall-memory"
const LEGACY_SNIPPET_TAG = "snippet"

function unescapeAttr(raw: string): string {
  // Values are JSON.stringify'd by the emitter; a hand-authored plain value
  // (no backslash) must round-trip too, so fall back to the raw text.
  if (!raw.includes("\\")) return raw
  try {
    const parsed: unknown = JSON.parse(`"${raw}"`)
    return typeof parsed === "string" ? parsed : raw
  } catch {
    return raw
  }
}

function parseAttrs(segment: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of segment.matchAll(ATTR_RE)) {
    const key = m[1]
    const value = m[2] ?? m[3] ?? m[4]
    if (key === undefined || value === undefined) continue
    out[key] = unescapeAttr(value)
  }
  return out
}

/**
 * End index (exclusive) of the `>` that closes the tag whose content starts at
 * `from`, skipping any `>` that sits inside a quoted attribute value. Returns
 * -1 at end of input.
 */
function tagEnd(text: string, from: number): number {
  let quote: string | null = null
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === "\\") {
        i++
        continue
      }
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === ">") {
      return i
    }
  }
  return -1
}

function isTagBoundary(ch: string | undefined): boolean {
  return ch === undefined || ch === ">" || ch === "/" || ch === " " || ch === "\t" || ch === "\n" || ch === "\r"
}

interface FoundTag {
  /** Index of the opening `<` within the scanned text. */
  readonly start: number
  readonly attrs: Record<string, string>
  /** Index of the char AFTER the closing `>`. */
  readonly after: number
}

/** Every `<name …>` opening tag in `text` (quote-aware), in document order. */
function findTags(text: string, name: string): FoundTag[] {
  const out: FoundTag[] = []
  const open = `<${name}`
  let from = 0
  for (;;) {
    const i = text.indexOf(open, from)
    if (i < 0) break
    const afterName = i + open.length
    if (!isTagBoundary(text[afterName])) {
      from = afterName
      continue
    }
    const end = tagEnd(text, afterName)
    if (end < 0) break
    out.push({ start: i, attrs: parseAttrs(text.slice(afterName, end)), after: end + 1 })
    from = end + 1
  }
  return out
}

/** Body of the element opened at `after`, up to its `</name>` (or text end). */
function innerOf(text: string, after: number, name: string): string {
  const close = text.indexOf(`</${name}>`, after)
  return close < 0 ? text.slice(after) : text.slice(after, close)
}

function toItem(attrs: Record<string, string>, body: string): ParsedInjectedItem {
  return {
    ...(attrs.id ? { id: attrs.id } : {}),
    ...(attrs.title ? { title: attrs.title } : {}),
    ...(attrs.path ? { path: attrs.path } : {}),
    ...(attrs.date ? { date: attrs.date } : {}),
    ...(attrs.type ? { type: attrs.type } : {}),
    ...(attrs.session ? { session: attrs.session } : {}),
    body: body.trim(),
  }
}

/**
 * A legacy `<snippet …>` unit as an item.
 *
 * The pre-chokepoint producer put the FULL vault fs_path (or node id) in
 * `source` for a vault match and shortened only opaque session UUIDs
 * (e77dc660^ inject-core.ts:505). So a `type="vault"` `source` is a PATH, and
 * a non-vault `source` is a session locator — mapping both to `session` (as a
 * first cut did) turns a saved vault path into an 8-char-truncated session and
 * loses it entirely (the 28904 review's compatibility MUST).
 */
function snippetToItem(inner: string, tag: FoundTag): ParsedInjectedItem {
  const a = tag.attrs
  const locator: Partial<Pick<ParsedInjectedItem, "path" | "session">> =
    a.source === undefined ? {} : a.type === "vault" ? { path: a.source } : { session: a.source }
  return toItem(
    {
      ...(a.title ? { title: a.title } : {}),
      ...(a.type ? { type: a.type } : {}),
      ...locator,
      // An explicit `session` attr always wins over a `source`-derived locator.
      ...(a.session ? { session: a.session } : {}),
    },
    innerOf(inner, tag.after, LEGACY_SNIPPET_TAG),
  )
}

/** Every `<snippet …>` unit directly inside `text`, with its position. */
function snippetUnits(text: string): Array<{ at: number; item: ParsedInjectedItem }> {
  return findTags(text, LEGACY_SNIPPET_TAG).map((tag) => ({ at: tag.start, item: snippetToItem(text, tag) }))
}

/** The `<vault-notice>` unit directly inside `text`, with its position. */
function noticeUnit(text: string, notice: FoundTag): { at: number; item: ParsedInjectedItem } {
  return {
    at: notice.start,
    item: { title: "vault notice", type: "notice", body: innerOf(text, notice.after, VAULT_NOTICE_TAG).trim() },
  }
}

/**
 * The pre-chokepoint units found inside `inner`, in document order: a bare
 * `<vault-notice>` and the `<snippet …>` units of each `<recall-memory>`.
 * Used to attach legacy units to their containing recall envelope (and to read
 * a bare legacy block from an older transcript).
 */
function legacyUnits(inner: string): Array<{ at: number; item: ParsedInjectedItem }> {
  const found: Array<{ at: number; item: ParsedInjectedItem }> = []
  for (const wrapper of findTags(inner, LEGACY_RECALL_TAG)) {
    const wInner = innerOf(inner, wrapper.after, LEGACY_RECALL_TAG)
    for (const u of snippetUnits(wInner)) {
      found.push({ at: wrapper.after + u.at, item: u.item })
    }
  }
  for (const notice of findTags(inner, VAULT_NOTICE_TAG)) {
    found.push(noticeUnit(inner, notice))
  }
  return found
}

/** Framed `<item>` and nested legacy units of an envelope body, in order. */
function parseItems(inner: string): ParsedInjectedItem[] {
  const found: Array<{ at: number; item: ParsedInjectedItem }> = findTags(inner, INJECTION_ITEM_TAG).map((tag) => ({
    at: tag.start,
    item: toItem(tag.attrs, innerOf(inner, tag.after, INJECTION_ITEM_TAG)),
  }))
  found.push(...legacyUnits(inner))
  found.sort((a, b) => a.at - b.at)
  return found.map((f) => f.item)
}

/**
 * Read every envelope out of `text`, in document order — modern
 * `<injected_context>` blocks and the legacy shape alike. A legacy block that
 * sits INSIDE a modern envelope is not returned separately: its units are items
 * of the containing envelope. Tolerant by design: a transcript, a broadcast
 * that quoted an envelope, or a turn carrying both the user text and the
 * envelope all parse; text with no envelope yields `[]` (never a throw, never a
 * silent empty object).
 */
export function parseInjectedContext(text: string): ParsedInjectedContext[] {
  const found: Array<{ at: number; env: ParsedInjectedContext }> = []
  const consumed: Array<[number, number]> = []

  for (const tag of findTags(text, INJECTION_ENVELOPE_TAG)) {
    const close = text.indexOf(`</${INJECTION_ENVELOPE_TAG}>`, tag.after)
    const inner = close < 0 ? text.slice(tag.after) : text.slice(tag.after, close)
    found.push({
      at: tag.start,
      env: { source: tag.attrs.source ?? "", mode: tag.attrs.mode ?? "", attrs: tag.attrs, items: parseItems(inner) },
    })
    consumed.push([tag.start, close < 0 ? text.length : close + `</${INJECTION_ENVELOPE_TAG}>`.length])
  }

  // Bare legacy blocks in an older transcript (those inside a modern envelope
  // are already items of it, above).
  const insideModern = (pos: number): boolean => consumed.some(([s, e]) => pos >= s && pos < e)
  for (const wrapper of findTags(text, LEGACY_RECALL_TAG)) {
    if (insideModern(wrapper.start)) continue
    const items = snippetUnits(innerOf(text, wrapper.after, LEGACY_RECALL_TAG)).map((u) => u.item)
    if (items.length > 0) {
      found.push({ at: wrapper.start, env: { source: "recall", mode: "snippet", attrs: {}, items } })
    }
  }
  for (const notice of findTags(text, VAULT_NOTICE_TAG)) {
    if (insideModern(notice.start)) continue
    const unit = noticeUnit(text, notice)
    found.push({ at: unit.at, env: { source: "recall", mode: "snippet", attrs: {}, items: [unit.item] } })
  }

  found.sort((a, b) => a.at - b.at)
  return found.map((f) => f.env)
}

/**
 * Whether `text` carries an envelope from `source` (e.g. `recall`) — modern or
 * legacy. The classification primitive: a consumer asks this instead of matching
 * a wrapper tag, so the tag spelling lives here and nowhere else.
 */
export function hasInjectedContextFrom(text: string, source: string): boolean {
  return parseInjectedContext(text).some((envelope) => envelope.source === source)
}
