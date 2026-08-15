import type { AuthorityEnvelope } from "./domain.js";

/**
 * The starting authority envelope: routine conversation is allowed, anything consequential asks,
 * and the seven hard-denied capabilities are typed `"DENY"` so a permissive envelope cannot be
 * constructed. Kept in a schema-free module so the browser bundle does not pull in Zod to read it.
 */
export const defaultAuthority: AuthorityEnvelope = {
  navigateIvr: "ALLOW",
  explainIssue: "ALLOW",
  askQuestions: "ALLOW",
  requestEscalation: "ALLOW",
  requestCaseNumber: "ALLOW",
  requestWrittenConfirmation: "ALLOW",
  disclosePersonalData: "ASK",
  acceptFinancialOutcome: "ASK",
  acceptAlternativeOutcome: "ASK",
  modifyAccount: "ASK",
  cancelService: "ASK",
  scheduleCommitment: "ASK",
  endWithoutResolution: "ASK",
  makePurchase: "DENY",
  discloseCredential: "DENY",
  discloseOtp: "DENY",
  discloseFullSsn: "DENY",
  disclosePaymentCard: "DENY",
  waiveLegalRight: "DENY",
  impersonateUser: "DENY",
  maximumAuthorizedCostCents: 0,
  forbiddenActions: [],
};
