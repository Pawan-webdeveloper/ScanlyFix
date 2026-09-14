export {
  detectThreats,
  normalizeForScan,
  deobfuscate,
  scanText,
  buildEvidence,
  SCANNED_HEADERS,
  type RequestSnapshotForThreats,
} from './detect.ts';
export { RULES, ALWAYS_RULES, TRIGGERED_RULES, hasTriggerChar, type Rule } from './signatures.ts';
export {
  buildThreatEvents,
  buildAuthAttemptEvent,
  buildAuthFailureEvent,
  clientIpFrom,
  parseClientIp,
  isAuthAttempt,
  type ThreatContext,
} from './report.ts';
export {
  SEVERITY_BY_KIND,
  THREAT_KINDS,
  THREAT_SURFACES,
  type ThreatConfidence,
  type ThreatEvent,
  type ThreatKind,
  type ThreatMatch,
  type ThreatSeverity,
  type ThreatSurface,
} from './types.ts';
