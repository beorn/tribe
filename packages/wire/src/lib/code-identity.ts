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
