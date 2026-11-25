/**
 * Watchlist CLI verbs for the canonical `tribe-wire` CLI.
 *
 * Manages GitHub repos and issues/PRs watched by Tribe's existing GitHub poller:
 *   - `tribe watch add <target> [--owner <seat>] [--operator] [--json]`
 *   - `tribe watch list [--json]`
 *   - `tribe watch remove <target> [--json]`
 */
import type { Command } from "@silvery/commander"
import {
  addGitHubWatchEntry,
  GITHUB_WATCHLIST_MAX_ITEMS,
  readGitHubWatchlist,
  removeGitHubWatchEntry,
  resolveDefaultWatchOwner,
  resolveGitHubWatchlistPath,
} from "../lib/github-watchlist.ts"
import { writeJsonStdout } from "./json-output.ts"

export { resolveDefaultWatchOwner }

export function registerWatchCommands(program: Command): void {
  const watch = program.command("watch").description("Manage GitHub repos and issues/PRs monitored by Tribe")

  watch
    .command("add")
    .description("Add or update a GitHub repo, issue, or PR on the watchlist")
    .argument("<target>", "GitHub URL or shorthand (owner/repo, owner/repo#123, or https://github.com/...)")
    .option("--owner <seat>", "Owning seat that receives activity notifications (defaults to current seat)")
    .option("--operator", "Also notify @chief/chat when the operator follows this target", false)
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (target: string, opts: { owner?: string; operator?: boolean; json?: boolean }) => {
      try {
        const owner = opts.owner?.trim() || resolveDefaultWatchOwner()
        const path = resolveGitHubWatchlistPath()
        const result = addGitHubWatchEntry(path, {
          target,
          owner,
          operatorFollows: Boolean(opts.operator),
        })
        if (opts.json) {
          await writeJsonStdout({
            ok: true,
            action: result.action,
            entry: result.entry,
            path,
          })
          return
        }
        const opSuffix = result.entry.operatorFollows ? ", operator: @chief/chat" : ""
        const verb = result.action === "added" ? "Watching" : "Updated watch"
        process.stdout.write(`${verb} ${result.entry.target} (owner: ${result.entry.owner}${opSuffix})\n`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (opts.json) {
          await writeJsonStdout({ ok: false, error: message })
        } else {
          process.stderr.write(`tribe watch add: ${message}\n`)
        }
        process.exitCode = 1
      }
    })

  watch
    .command("list")
    .description("List watched GitHub repos and issues/PRs")
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (opts: { json?: boolean }) => {
      try {
        const path = resolveGitHubWatchlistPath()
        const state = readGitHubWatchlist(path)
        const itemCount = state.entries.filter((entry) => entry.kind === "item").length
        if (opts.json) {
          await writeJsonStdout({
            path,
            count: state.entries.length,
            itemCount,
            maxItems: GITHUB_WATCHLIST_MAX_ITEMS,
            entries: state.entries,
          })
          return
        }
        if (state.entries.length === 0) {
          process.stdout.write(
            `No GitHub watchlist entries in ${path} (0/${GITHUB_WATCHLIST_MAX_ITEMS} items). ` +
              `Add one with: tribe watch add <url-or-repo> --owner <seat>\n`,
          )
          return
        }
        for (const entry of state.entries) {
          const opSuffix = entry.operatorFollows ? " +operator(@chief/chat)" : ""
          process.stdout.write(`${entry.target}\t${entry.kind}\t${entry.owner}${opSuffix}\tadded ${entry.addedAt}\n`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (opts.json) {
          await writeJsonStdout({ ok: false, error: message })
        } else {
          process.stderr.write(`tribe watch list: ${message}\n`)
        }
        process.exitCode = 1
      }
    })

  watch
    .command("remove")
    .description("Stop watching a GitHub repo, issue, or PR")
    .argument("<target>", "GitHub URL or shorthand to remove")
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (target: string, opts: { json?: boolean }) => {
      try {
        const path = resolveGitHubWatchlistPath()
        const result = removeGitHubWatchEntry(path, target)
        if (opts.json) {
          await writeJsonStdout({
            ok: true,
            removed: result.removed,
            path,
          })
          return
        }
        process.stdout.write(`Stopped watching ${result.removed.target} (was owned by ${result.removed.owner})\n`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (opts.json) {
          await writeJsonStdout({ ok: false, error: message })
        } else {
          process.stderr.write(`tribe watch remove: ${message}\n`)
        }
        process.exitCode = 1
      }
    })
}
