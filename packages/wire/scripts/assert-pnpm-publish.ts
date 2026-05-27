const userAgent = process.env.npm_config_user_agent ?? ""

if (!userAgent.startsWith("pnpm/")) {
  console.error(
    [
      "tribe-wire must be published with pnpm, not npm.",
      "",
      "Reason: tribe-wire uses publishConfig to publish dist/*.mjs bin/exports",
      "while keeping src/*.ts exports for local workspace development. npm publish",
      "does not apply those publishConfig bin/exports fields, which publishes a",
      "broken `tribe-wire` binary that points at src/cli.ts.",
      "",
      "Use:",
      "  pnpm publish --access public --no-git-checks",
      "",
      "Then verify:",
      "  npm view tribe-wire version bin exports --json",
      "  bunx tribe-wire --help",
    ].join("\n"),
  )
  process.exit(1)
}
