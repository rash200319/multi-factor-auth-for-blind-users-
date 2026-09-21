/**
 * Explicit rule table, not a black box — readme.md §6.4. Determines whether
 * a routine login (Factors 1+2) is sufficient or whether Factor 3 (spoken
 * step-up code) must fire.
 */

export type RiskLevel = "low" | "high";

export const HIGH_VALUE_OPERATIONS = new Set([
  "payment",
  "credential_change",
  "recovery_contact_change",
  "data_export",
]);

export interface RiskContext {
  operation?: string; // one of HIGH_VALUE_OPERATIONS, or undefined for plain login
  isNewDevice: boolean; // credential not seen from this client fingerprint before
  isNewNetworkRange: boolean; // IP range differs from the user's recent sessions
  signCountOk: boolean; // false => possible clone, handled as a hard deny upstream, not step-up
}

export function evaluateRisk(ctx: RiskContext): RiskLevel {
  if (ctx.operation && HIGH_VALUE_OPERATIONS.has(ctx.operation)) return "high";
  if (ctx.isNewDevice) return "high";
  if (ctx.isNewNetworkRange) return "high";
  // AAL2 requires two factors, not three (PDF §5.3): a routine third factor
  // buys no assurance and costs accessibility, so the default is low.
  return "low";
}
