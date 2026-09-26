/**
 * A one-shot connection that speaks as its launch's live seat (25074 3d-1c, @cto 082a4259 (b)).
 *
 * The launch is the identity token's sid. The daemon answers which session holds that launch and under which
 * (launch_id, launch_parent_pid) tuple, and a one-shot that registers under the tuple fans into the live seat,
 * attributed and without takeover. The CLI's `tribe send` and the one service sender (service-send.ts) both register
 * this way, so a seat has one answer to "who am I on the wire" whichever path sends for it. Nothing here mints or
 * asserts a launch: the tuple is the daemon's own.
 */
import { mcpJsonContent } from "./cli/mcp-json-content.ts"
import { TRIBE_PROTOCOL_VERSION, TRIBE_SUPPORTED_PROTOCOL_VERSIONS } from "./lib/socket.ts"

export type DaemonCall = (method: string, params: Record<string, unknown>) => Promise<unknown>

/** The seat holding a launch, the tuple a one-shot registers under to fan into it, and the daemon's full answer. */
export type LaunchSeat = Readonly<{
  session: string
  launchId: string
  launchParentPid: number
  status: Readonly<Record<string, unknown>>
}>

/**
 * Ask the daemon which seat holds `launchId`. `persona` narrows a launch that hosts several sessions; the daemon
 * ignores it for a sole one. Throws, naming the launch, when the daemon has no current session for it or answers
 * without the tuple.
 */
export async function resolveLaunchSeat(
  call: DaemonCall,
  launch: Readonly<{ launchId: string; persona?: string | null }>,
): Promise<LaunchSeat> {
  const status = mcpJsonContent(
    await call("cli_inbox_status_by_launch_v1", {
      launch_id: launch.launchId,
      ...(launch.persona ? { persona: launch.persona } : {}),
    }),
  ) as Record<string, unknown>
  const session = status.session
  if (typeof session !== "string" || session.length === 0) {
    throw new Error(`daemon launch authority returned no current session for launch id ${launch.launchId}`)
  }
  const launchId = status.launch_id
  const launchParentPid = status.launch_parent_pid
  if (
    typeof launchId !== "string" ||
    launchId.length === 0 ||
    typeof launchParentPid !== "number" ||
    !Number.isSafeInteger(launchParentPid) ||
    launchParentPid <= 0
  ) {
    throw new Error(
      `daemon launch authority named ${session} for launch id ${launch.launchId} without its (launch_id, launch_parent_pid) tuple`,
    )
  }
  return { session, launchId, launchParentPid, status }
}

/** The register a one-shot sender makes: its name, and the launch tuple when it speaks as that launch's seat. */
export function oneShotRegisterParams(
  as: Readonly<{ name: string; launchId?: string; launchParentPid?: number }>,
  cwd: string = process.cwd(),
  pid: number = process.pid,
): Record<string, unknown> {
  return {
    name: as.name,
    role: "member",
    domains: [],
    delivery: "pull",
    project: cwd,
    projectName: cwd.split("/").filter(Boolean).at(-1) ?? "unknown",
    pid,
    protocolVersion: TRIBE_PROTOCOL_VERSION - 1,
    supportedProtocolVersions: [...TRIBE_SUPPORTED_PROTOCOL_VERSIONS],
    ...(as.launchId !== undefined && as.launchParentPid !== undefined
      ? { launchId: as.launchId, launchParentPid: as.launchParentPid }
      : {}),
  }
}
