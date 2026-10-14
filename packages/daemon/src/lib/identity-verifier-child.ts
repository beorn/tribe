/**
 * The spawned side of the identity-verifier seam (28921, @cto e87d593d).
 *
 * Tribe declares the contract and never verifies a token itself (25074 3b, @cto 4a194bbf): the composing layer names a
 * MODULE that exports it. That contract is unchanged here — what changes is WHERE the module runs. The daemon used to
 * import it in process, which pinned the verifier to the daemon's own landing (a promotion that changed the verifier
 * could not reach the fleet without a wire restart) and dragged ag's code into the daemon's own process, which is why
 * wire's `ag` pin was load-bearing. This runner is spawned per call, imports the module at the path it is handed IN
 * ITS OWN FRESH PROCESS, and answers exactly one request.
 *
 * Wire format: one JSON request on stdin, exactly one JSON line on stdout, exit 0. A harness failure exits non-zero
 * with ONE named line on stderr and NO stdout, so a failure can never be read as a verdict. The token travels on
 * stdin only: nothing secret ever reaches this process's argv.
 *
 *   {"op":"hello"}                    -> {"interface":1,"suppliesGen":bool,"emitters":[…],"policyFault":null|string}
 *   {"op":"verify","token":"…"}                                -> one verdict
 *   {"op":"authorize","identity":{…},"emitter":"…","operation":"read|raise|clear"}
 *                                                              -> {"allow":bool,"emitters":[…]}
 *
 * The `authorize` answer carries the emitter list the CURRENT module declares, so the daemon can notice that its
 * cached copy drifted instead of quietly authorizing against a list nobody re-read.
 */
import { existsSync } from "node:fs"
import { isAbsolute } from "node:path"
import {
  CHILD_STDERR_MARKER,
  IDENTITY_VERIFIER_INTERFACE_VERSION,
  loadVerifierModule,
  type IdentityVerdict,
  type IncidentPolicy,
  type IncidentOperation,
} from "./identity-verifier.ts"

function fail(reason: string): never {
  process.stderr.write(`${CHILD_STDERR_MARKER}${reason}\n`)
  process.exit(2)
}

function readModulePath(argv: readonly string[]): string {
  const at = argv.indexOf("--module")
  const value = at === -1 ? undefined : argv[at + 1]
  if (value === undefined || value.trim() === "") fail("no --module <absolute path> was given")
  if (!isAbsolute(value)) fail(`--module ${value} is not an absolute path`)
  if (!existsSync(value)) fail(`--module ${value} does not exist`)
  return value
}

async function readRequest(): Promise<unknown> {
  const chunks: Uint8Array[] = []
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk)
  const text = new TextDecoder().decode(Buffer.concat(chunks))
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // The parse message can quote the input; the input is a token, so it is never repeated back.
    fail(`the request on stdin is not JSON: ${message.split(text).join("[request redacted]")}`)
  }
}

export async function answer(request: unknown, modulePath: string): Promise<unknown> {
  const op = (request as { readonly op?: unknown } | null)?.op
  const loaded = await loadVerifierModule(modulePath).catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error))
  })
  switch (op) {
    case "hello": {
      // A broken incident policy must NOT take identity verification down with it (28044 AC1): hello answers either
      // the emitter list or the named policy fault, and the daemon keeps serving verified registrations either way.
      let emitters: readonly string[] | null = null
      let policyFault: string | null = null
      try {
        emitters = loaded.readIncidentPolicy().emitters
      } catch (error) {
        policyFault = error instanceof Error ? error.message : String(error)
      }
      return {
        interface: IDENTITY_VERIFIER_INTERFACE_VERSION,
        suppliesGen: loaded.suppliesGen,
        emitters,
        policyFault,
      }
    }
    case "verify": {
      const token = (request as { readonly token?: unknown }).token
      if (typeof token !== "string" || token === "") fail("a verify request needs a non-empty string token")
      return loaded.verify(token)
    }
    case "authorize": {
      const { identity, emitter, operation } = request as {
        readonly identity?: unknown
        readonly emitter?: unknown
        readonly operation?: unknown
      }
      if (typeof emitter !== "string" || emitter === "") fail("an authorize request needs a non-empty emitter")
      if (operation !== "read" && operation !== "raise" && operation !== "clear") {
        fail(`an authorize request needs operation read|raise|clear, not ${JSON.stringify(operation)}`)
      }
      let policy: IncidentPolicy
      try {
        policy = loaded.readIncidentPolicy()
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error))
      }
      const allowed = await policy.authorize(
        identity as Extract<IdentityVerdict, { result: "verified" }>,
        emitter,
        operation as IncidentOperation,
      )
      return { allow: allowed === true, emitters: policy.emitters }
    }
    default:
      fail(`unknown op ${JSON.stringify(op)}: expected hello, verify or authorize`)
  }
}

if (import.meta.main) {
  const modulePath = readModulePath(process.argv.slice(2))
  try {
    const response = await answer(await readRequest(), modulePath)
    process.stdout.write(`${JSON.stringify(response)}\n`)
    process.exit(0)
  } catch (error) {
    // One named line on stderr, no stdout: the parent can never read a failure as a verdict.
    fail(error instanceof Error ? error.message : String(error))
  }
}
