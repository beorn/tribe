/**
 * The launch's identity token (25074 3b). A managed launch carries it, and `register` forwards it as `idToken`;
 * tribe never reads its claims here: the daemon's composing-layer verifier decides what it proves. An unset or
 * empty variable is a launch without a token, served on its bearer or its claimed name.
 */
export const HAB_ID_TOKEN_ENV = "HAB_ID_TOKEN"

export function readIdentityTokenFromEnvironment(env: Readonly<NodeJS.ProcessEnv>): string | null {
  const raw = env[HAB_ID_TOKEN_ENV]
  return raw === undefined || raw.length === 0 ? null : raw
}
