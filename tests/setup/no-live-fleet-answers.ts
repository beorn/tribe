/**
 * Test processes never ask this machine for live fleet or profile facts (#38420).
 *
 * Recall now asks two live sources: `ag transcript roots` for the provider profile homes a seat runs under, and the
 * habitat's published plan (`run/habplan.json`) for the seats it declares. A test that lets either answer reads the
 * host's real profiles and the operator's real fleet, so its result depends on who runs it. Setup files load before
 * any test module, so every spawned child inherits the opt-out; a test that wants an answer passes one explicitly
 * (`IndexOptions.profileRoots`, `RECALL_HAB_PLAN=<plan path>`).
 */
process.env.RECALL_PROFILE_ROOTS ??= "off"
process.env.RECALL_HAB_PLAN ??= "off"
