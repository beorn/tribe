/**
 * Vault glossary — distinctive, file-backed vault terms that count as
 * salience anchors even when they don't match the regex shapes in
 * prompt-filter.ts.
 *
 * Built lazily from `.km/state.db` on first use. Strict whitelist: only
 * pulls names from positions where being "named" implies project vocab,
 * not arbitrary `name` fields. Specifically:
 *
 *  - top-level directory names under vendor/, apps/, packages/, hub/,
 *    .claude/skills/ (e.g. "termless", "silvercode", "km-tui")
 *  - npm scope names like @silvery, @bearly, @flexily, @termless
 *  - per-vault bead scope segments from canonical bead paths
 *    (`@km/<scope>/<slug>` → both <scope> and <slug>)
 *
 * Plus a small explicit alias list for camelCase code-symbol terms that
 * never surface as path basenames (testEnv, createTestApp, etc).
 *
 * Anti-goal: this list is NOT a full project lexicon. Common words that
 * happen to be node names ("test", "check", "slow", "migration") must
 * NOT end up in here — that turns the salience override into a no-op.
 * Past 200 entries is a smell; past 500 means we're indexing noise.
 */

import { isContentWord, isStopword, openVaultDb, promptWords, type PromptWord } from "./vault-fts.ts"

/** The vault the glossary below was read from: the caller names it, one glossary per path (@cto 456e6e77). */
let glossaryPath: string | null = null
let glossarySet: Set<string> | null = null
/** The vault's root scope names (`@ag/…` → `ag`), read in the glossary's pass: a short token naming one is an identifier. */
let rootScopeSet: Set<string> | null = null

const EXPLICIT_ALIASES: ReadonlyArray<string> = [
  // camelCase code-symbol terms
  "testenv",
  "createtestapp",
  // Frequently-named files
  "claude.md",
  "agents.md",
  "readme.md",
]

/**
 * 3-char project terms that are too short to pass the default token-length
 * gate but ARE distinctive in this codebase. Allowed at the lookup site
 * only — never auto-discovered. Each entry must be a project-specific
 * abbreviation that almost never appears as common English; "max", "big",
 * "why", "sop", "pro" are deliberately EXCLUDED because they clash with
 * conversational English ("max value", "big deal", "why...?", "I'm a pro
 * at this").
 */
const SHORT_EXPLICIT_ALIASES: ReadonlySet<string> = new Set([
  "tdd", // .claude/skills/tests/SKILL.md — test-driven development
  "csw", // .claude/skills/csw/SKILL.md — complete staff work
])

/**
 * Top-level directories whose immediate children are project-vocab terms.
 * "vendor/termless/..." → "termless". "apps/km-tui/..." → "km-tui".
 *
 * `.claude/skills/` is intentionally EXCLUDED. Skill invocation goes
 * through slash-command syntax (`/pro`, `/max`) which the slash-filter
 * already routes; bare mentions of skill names are almost always
 * conversational English ("Claude", "code", "open", "why", "pro", "max",
 * "big", "deep", "fresh", "complete", "discuss", "docs", "tests",
 * "tui", "sync", "release", "recall"). Auto-adding 50+ skill dir
 * names to the glossary would let conversational prompts trigger
 * retrieval — exactly the false_emit pattern we worked to eliminate.
 */
const PROJECT_DIRS: ReadonlyArray<string> = ["vendor/", "apps/", "packages/", "hub/"]

function buildGlossary(vaultDb: string): Set<string> | null {
  if (glossaryPath === vaultDb) return glossarySet
  // Opened before the path is recorded: a vault that cannot be opened refuses on every call, never cached as none.
  const db = openVaultDb(vaultDb)
  glossaryPath = vaultDb
  glossarySet = null
  rootScopeSet = null

  const out = new Set<string>(EXPLICIT_ALIASES.map((s) => s.toLowerCase()))

  try {
    const pathRows = db.prepare(`SELECT DISTINCT fs_path FROM nodes WHERE fs_path IS NOT NULL`).all() as Array<{
      fs_path: string
    }>

    for (const { fs_path } of pathRows) {
      // Direct file basenames (strict — only when the file looks like a
      // dotfile-or-readme variant; full lowercase basenames are too noisy
      // to whitelist wholesale).
      const lastSlash = fs_path.lastIndexOf("/")
      const basename = lastSlash >= 0 ? fs_path.slice(lastSlash + 1) : fs_path
      const lower = basename.toLowerCase()
      if (
        lower === "claude.md" ||
        lower === "agents.md" ||
        lower === "readme.md" ||
        lower === "package.json" ||
        lower === "tsconfig.json"
      ) {
        // Add the full filename only — NOT the stem. "claude" / "agents"
        // / "readme" / "package" / "tsconfig" are too common as bare
        // English words to use as salience anchors. The dotted form
        // ("CLAUDE.md") is itself the distinctive marker.
        out.add(lower)
      }

      // Project-dir children: vendor/<NAME>/..., apps/<NAME>/...
      for (const prefix of PROJECT_DIRS) {
        if (!fs_path.startsWith(prefix)) continue
        const rest = fs_path.slice(prefix.length)
        const slash = rest.indexOf("/")
        const name = slash >= 0 ? rest.slice(0, slash) : rest
        if (name.length >= 3 && /^[a-z][a-z0-9-]*$/.test(name)) {
          out.add(name)
        }
        break
      }
    }

    // Bead canonical-form scopes from sigil-prefixed paths.
    // `@km/<scope>/<slug>` → add only <scope> when the scope is a
    // distinctive project area (km-tui, km-storage, km-beads, ...). Slugs
    // are too varied and almost always contain common English words —
    // including them would let "migration" / "testing" / "performance"
    // through as anchors.
    const beadRows = db
      .prepare(
        `SELECT DISTINCT fs_path FROM nodes
         WHERE fs_path LIKE '@%/%'`,
      )
      .all() as Array<{ fs_path: string }>

    const roots = new Set<string>()
    for (const { fs_path } of beadRows) {
      const parts = fs_path.replace(/\.md$/, "").split("/")
      const root = parts[0]?.slice(1)
      if (root && root.length >= 2 && /^[a-z][a-z0-9-]*$/.test(root)) roots.add(root)
      // parts[0] = "@km", parts[1] = scope. Only the scope.
      const scope = parts[1]
      if (scope && scope.length >= 4 && /^[a-z][a-z0-9-]*$/.test(scope)) {
        out.add(scope)
      }
    }

    glossarySet = out
    rootScopeSet = roots
    return out
  } catch {
    // silent-fallback-allow: unavailable vault glossary only disables anchor-term boosting.
    return null
  }
}

/** The vault query for a prompt: what call A of the prompt hook searches the vault with (@ag/recall Phase 3). */
export interface VaultAnchor {
  query: string
  /** The identifier that leads the query, or null when the query is the prompt's first content words. */
  identifier: string | null
}

const ANCHOR_WORDS = 3
const AT_REF = /^@[A-Za-z0-9][\w.-]*(?:\/[\w.-]+)*$/u
const PATH = /^[\w.-]+\/[\w./-]+$/u
const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/u
const CAMEL = /^(?:[a-z]+[A-Z]|[A-Z][a-z0-9]+[A-Z])[A-Za-z0-9]*$/u
const BEAD_NUMBER = /^\d{4,6}$/u
const PROPER = /^[A-Z][a-z]+$/u

/**
 * The vault query for a prompt, identifier-first (@cto 7f55e4f2, from @dev/5's measurement): the first identifier the
 * prompt names (an @ref, a path, kebab-case, camelCase, a bead number, a vault root scope such as `ag`, a glossary
 * term, or a proper noun mid-sentence such as `Jev`, however short) followed by the next content words, three tokens
 * in all; with no identifier, the first three content words. Null when the prompt has neither. A short query, never
 * the verbatim prompt: searchVault tries every term together first. `vaultDb` is the vault whose scopes and glossary
 * count as identifiers, named by the caller; null, only the shapes and proper nouns do.
 */
export function deriveVaultAnchor(prompt: string, vaultDb: string | null): VaultAnchor | null {
  const glossary = vaultDb === null ? null : buildGlossary(vaultDb)
  const roots = glossary === null ? null : rootScopeSet
  const words = promptWords(prompt)
  const isIdentifier = ({ token, opensSentence }: PromptWord): boolean => {
    const lower = token.toLowerCase()
    if ([AT_REF, PATH, KEBAB, CAMEL, BEAD_NUMBER].some((shape) => shape.test(token))) return true
    if (roots?.has(lower) || glossary?.has(lower) || SHORT_EXPLICIT_ALIASES.has(lower)) return true
    return !opensSentence && PROPER.test(token) && !isStopword(lower)
  }
  const contentAfter = (from: number, count: number): string[] =>
    words
      .slice(from)
      .map((w) => w.token)
      .filter(isContentWord)
      .slice(0, count)
      .map((t) => t.toLowerCase())
  const at = words.findIndex(isIdentifier)
  const identifier = words[at]?.token
  if (identifier !== undefined) {
    return { query: [identifier, ...contentAfter(at + 1, ANCHOR_WORDS - 1)].join(" "), identifier }
  }
  const content = contentAfter(0, ANCHOR_WORDS)
  return content.length > 0 ? { query: content.join(" "), identifier: null } : null
}
