/**
 * The repo engine's measurement identity.
 *
 * Mirrors @scanlyfix/checks' ENGINE_VERSION for exactly the same reason: two
 * repo scans are only comparable when the thing that produced them was the same.
 * Any feature that subtracts one repo scan from another — a push-rescan diff,
 * a regression alert, a PR gate — must refuse to compare across a change here.
 *
 * Without that, the first time we ship the deep-scan checks every monitored
 * repo gets told it got worse on the day we deployed. The repo did not change;
 * the ruler did.
 *
 * When to change it:
 *   MINOR — a check was added to or removed from allRepoChecks. Coverage moved,
 *           so the same repo legitimately scores differently.
 *   PATCH — an existing check's severity or logic changed what it reports for
 *           unchanged input. A wording fix is not a patch bump; a threshold is.
 *   MAJOR — the shape of RepoScanScores or RepoFinding changed, i.e. stored
 *           repo scans can no longer be read by the current code.
 *
 * The registry count test in test/registry.test.ts is the tripwire: it fails on
 * every registry change, which is the moment to come back here.
 */
export const REPO_ENGINE_VERSION = '0.2.0'
