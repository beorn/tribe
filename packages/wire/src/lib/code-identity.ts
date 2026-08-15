import { execFileSync } from "node:child_process"
import { relative } from "node:path"

export type GitProbe =
  | { ok: true; value: string }
  | { ok: false; failure: { path: string; operation: string; errno: string; message: string } }

function cleanGitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
}

/** Resolve one git fact with enough failure evidence for an operator-facing UNKNOWN verdict. */
export function probeGitValue(path: string, args: readonly string[]): GitProbe {
  const operation = `git ${args.join(" ")}`
  try {
    const value = execFileSync("git", ["-C", path, ...args], {
      encoding: "utf8",
      env: cleanGitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
    if (value.length > 0) return { ok: true, value }
    return { ok: false, failure: { path, operation, errno: "EMPTY_RESULT", message: "git returned no value" } }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { status?: unknown; stderr?: unknown }
    const errno = failure.code ?? (typeof failure.status === "number" ? `exit-${failure.status}` : "UNKNOWN")
    const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : ""
    return {
      ok: false,
      failure: {
        path,
        operation,
        errno,
        message: stderr || failure.message || String(error),
      },
    }
  }
}

export interface CheckoutCodeIdentity {
  onDisk: GitProbe
  superprojectPin: GitProbe
}

/** Resolve the checkout HEAD and the hosting superproject's pin from one reported source root. */
export function resolveCheckoutCodeIdentity(root: string): CheckoutCodeIdentity {
  const onDisk = probeGitValue(root, ["rev-parse", "HEAD"])
  const superproject = probeGitValue(root, ["rev-parse", "--show-superproject-working-tree"])
  if (!superproject.ok) return { onDisk, superprojectPin: superproject }
  const top = probeGitValue(root, ["rev-parse", "--show-toplevel"])
  if (!top.ok) return { onDisk, superprojectPin: top }
  const submodulePath = relative(superproject.value, top.value)
  if (submodulePath.length === 0) {
    return {
      onDisk,
      superprojectPin: {
        ok: false,
        failure: {
          path: root,
          operation: "resolve superproject pin",
          errno: "NO_SUBMODULE_PATH",
          message: "reported source root is not a submodule of its superproject",
        },
      },
    }
  }
  return {
    onDisk,
    superprojectPin: probeGitValue(superproject.value, ["rev-parse", `HEAD:${submodulePath}`]),
  }
}

export type PinDirection = "checkout-ahead" | "checkout-behind" | "divergent" | "unknown"

export type AncestorProbe =
  | { ok: true; isAncestor: boolean }
  | { ok: false; failure: { path: string; operation: string; errno: string; message: string } }

/**
 * `git -C <path> merge-base --is-ancestor <maybeAncestor> <maybeDescendant>`.
 * Per git's own contract for `--is-ancestor`: exit 0 is a definitive true,
 * exit 1 is a definitive false — both are `ok: true` answers. Any other exit
 * (e.g. one of the two commits is not a valid object in this checkout, such
 * as a shallow clone missing the history) is a real failure, surfaced as
 * `ok: false` rather than folded into "not an ancestor" — an indeterminate
 * ancestry answer must stay visible, never guessed.
 */
export function probeIsAncestor(path: string, maybeAncestor: string, maybeDescendant: string): AncestorProbe {
  const operation = `git merge-base --is-ancestor ${maybeAncestor} ${maybeDescendant}`
  try {
    execFileSync("git", ["-C", path, "merge-base", "--is-ancestor", maybeAncestor, maybeDescendant], {
      encoding: "utf8",
      env: cleanGitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { ok: true, isAncestor: true }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { status?: unknown; stderr?: unknown }
    const status = typeof failure.status === "number" ? failure.status : null
    if (status === 1) return { ok: true, isAncestor: false }
    const errno = failure.code ?? (status === null ? "UNKNOWN" : `exit-${status}`)
    const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : ""
    return {
      ok: false,
      failure: { path, operation, errno, message: stderr || failure.message || String(error) },
    }
  }
}

/**
 * Ancestry direction between an on-disk checkout and a pin that names its
 * expected commit — for the precondition case where the two already differ
 * (equal SHAs have no direction to resolve; callers must gate on that first).
 *
 *   - "checkout-ahead"  — pin is an ancestor of onDisk: the checkout already
 *     contains the pin's commit plus more. The PIN is stale, not the
 *     checkout; no submodule-update remedy applies here — running one would
 *     roll the checkout backward onto the older pin.
 *   - "checkout-behind" — onDisk is an ancestor of pin: the pin's commit is
 *     not yet in the checkout. The "materialize the pin" remedy applies.
 *   - "divergent"       — neither contains the other: two different lines of
 *     history. Needs investigation, not a mechanical remedy.
 *   - "unknown"         — ancestry could not be established (e.g. one SHA is
 *     not a valid object in this checkout). Never guessed toward a remedy.
 */
export function resolvePinDirection(path: string, onDisk: string, pin: string): PinDirection {
  const pinIsAncestorOfOnDisk = probeIsAncestor(path, pin, onDisk)
  if (!pinIsAncestorOfOnDisk.ok) return "unknown"
  if (pinIsAncestorOfOnDisk.isAncestor) return "checkout-ahead"
  const onDiskIsAncestorOfPin = probeIsAncestor(path, onDisk, pin)
  if (!onDiskIsAncestorOfPin.ok) return "unknown"
  if (onDiskIsAncestorOfPin.isAncestor) return "checkout-behind"
  return "divergent"
}
