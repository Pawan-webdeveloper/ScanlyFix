/**
 * Guard's public surface.
 *
 * Listed explicitly rather than re-exported wholesale: `MAX_ROUTE_STALENESS_DAYS`
 * is defined in classify.ts and re-exported by sync.ts as part of its own
 * contract, and a pair of `export *` would leave which one wins to module
 * resolution rather than to a decision.
 */

export {
  classifyEnforcement,
  classifyRoute,
  classifySessionProfile,
  daysSince,
  ENFORCEMENT_HINT,
  ENFORCEMENT_LABEL,
  isProbeable,
  isSampleRoute,
  isStale,
  MAX_ROUTE_STALENESS_DAYS,
  MIN_PASSES_FOR_INCONSISTENT,
  MIN_SAMPLES,
  openRatio,
  PUBLIC_MIN_OPEN_RATIO,
  servedAnonymous,
  SESSION_ONLY_MAX_OPEN_RATIO,
  SESSION_PROFILE_LABEL,
  totalRequests,
  type Enforcement,
  type RouteIdentity,
  type RouteTraffic,
  type RouteVerdict,
  type SessionProfile,
} from './classify.ts';

export {
  buildTargetSet,
  classifyRoutes,
  computeCoverage,
  coverageTone,
  isProbed,
  targetKey,
  type ClassifiedRoute,
  type GuardCoverage,
  type GuardRouteInput,
} from './coverage.ts';

export {
  collectGuardFindings,
  countBySeverity,
  findingsForRoute,
  GUARD_FINDING_LABEL,
  GUARD_SEVERITY_ORDER,
  RECON_MIN_ANONYMOUS_REQUESTS,
  type GuardFinding,
  type GuardFindingKind,
  type GuardSeverity,
} from './findings.ts';

export {
  computeNeedsSession,
  computeNeedsSessionFromStats,
  NEEDS_SESSION_MAX_OPEN_RATIO,
  NEEDS_SESSION_MIN_SAMPLES,
  type RouteStatEntry,
} from './heuristic.ts';

export { describeSyncResult } from './summary.ts';

export {
  isRouteFresh,
  MAX_ROUTE_STALENESS_MS,
  syncGuardRoutesToProber,
  type SyncGuardRoutesOptions,
  type SyncResult,
} from './sync.ts';

export {
  filterAndSortRoutes,
  formatRelativeTime,
  isNewRoute,
  matchesFilter,
  matchesSearch,
  needsAttention,
  NEW_ROUTE_WINDOW_MS,
  ROUTE_FILTER_LABEL,
  ROUTE_SORT_LABEL,
  sessionPct,
  sortRoutes,
  type RouteFilter,
  type RouteSort,
} from './view.ts';
