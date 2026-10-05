/**
 * The HAB_SESSION_* and HAB_SERVICE_* variable names, each defined once (25074 one stripper S2, @cto 12fd77d5).
 *
 * Hab writes them into every process it launches and tribe reads them as config, so they are protocol vocabulary
 * shared by both, and they live at the lowest package that reads any of them. Import-free on purpose: bare
 * `hab --help` reaches this module through the unit-run contract, and every list that names these variables (the
 * daemon's markers, hab's caller-identity stripper, custody's classifier) is built from these constants, never from a
 * second spelling. hab-core re-exports them under the same names.
 */

/** A managed seat launch's id; a seat carries it with its habitat root, and one without the other is a broken launch. */
export const HAB_SESSION_LAUNCH_ID_ENV = "HAB_SESSION_LAUNCH_ID"
/** The habitat root every hab launch carries. */
export const HAB_SESSION_HABITAT_ROOT_ENV = "HAB_SESSION_HABITAT_ROOT"
/** The habitat's name, written only when its habplan is named. */
export const HAB_SESSION_HABITAT_NAME_ENV = "HAB_SESSION_HABITAT_NAME"
/** The instruction file a managed launch was anchored to. */
export const HAB_SESSION_INSTRUCTION_ANCHOR_ENV = "HAB_SESSION_INSTRUCTION_ANCHOR"
/** Injected by a Hab supervisor into the process it runs; a seat carries none. */
export const HAB_SESSION_DIR_ENV = "HAB_SESSION_DIR"
/** The name of the hab service a supervised process is. */
export const HAB_SERVICE_NAME_ENV = "HAB_SERVICE_NAME"
/** The launch's signed identity token (25074 3b); hab sets it per launch, so it is one of this family. */
export const HAB_ID_TOKEN_ENV = "HAB_ID_TOKEN"
/**
 * The PATH of the 0600 file holding the launch's signed identity token (27314 B1). The file is per launch, under that
 * launch's runtime directory, and lives exactly as long as the launch. Preferred over {@link HAB_ID_TOKEN_ENV}: a
 * value in the environment reaches a session through an unfiltered dump.
 */
export const HAB_ID_TOKEN_FILE_ENV = "HAB_ID_TOKEN_FILE"
