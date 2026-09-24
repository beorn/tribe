#!/usr/bin/env bash
# The plugin's one start path: .mcp.json and `bun run start` both run this file.
#
# Install only when the server's imports do not resolve. A checkout that already
# resolves them (a host workspace that vendors tribe, or an installed clone) is
# not this launch's to rewrite: installing there relinks the host's
# node_modules under every running process. A failed install stops the start
# with its own stderr, rather than starting a server on a half-written tree.
#
# The server starts in the caller's directory: the adapter registers that
# directory as its project, so only the check and the install change into the
# plugin root.
set -euo pipefail
root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")" && pwd)}"
if ! (cd "$root" && bun -e 'import.meta.resolve("tribe-wire/lib/persona-name"); import.meta.resolve("@modelcontextprotocol/sdk/server/index.js")') >/dev/null 2>&1; then
  echo "tribe plugin: dependencies do not resolve from $root; running bun install" >&2
  (cd "$root" && bun install --no-summary)
fi
exec bun "$root/server.ts"
