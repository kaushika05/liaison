import { createHmac, randomBytes } from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js";

const callAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function generateCallAuthorizationCode(length = 6): string {
  if (length < 4 || length > 12) throw new Error("INVALID_CALL_CODE_LENGTH");
  let result = "";
  const limit = 256 - (256 % callAlphabet.length);
  while (result.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte < limit) result += callAlphabet[byte % callAlphabet.length];
      if (result.length === length) break;
    }
  }
  return result;
}

export function hashCallAuthorization(input: {
  secret: string;
  threadId: string;
  caseId: string;
  planVersion: number;
  destination: string;
  telephonyMode: "simulator" | "twilio";
  code: string;
}): string {
  if (input.secret.length < 16) throw new Error("CALL_TOKEN_SECRET_TOO_SHORT");
  return createHmac("sha256", input.secret)
    .update(
      `liaison-call-v1\0${input.threadId}\0${input.caseId}\0${input.planVersion}\0${input.destination}\0${input.telephonyMode}\0${input.code.trim().toUpperCase()}`,
    )
    .digest("hex");
}

export function generateSecureActionToken(): string {
  return randomBytes(32).toString("base64url");
}
export function hashSecureActionToken(token: string, secret: string): string {
  if (secret.length < 16) throw new Error("ACTION_LINK_SECRET_TOO_SHORT");
  return createHmac("sha256", secret).update(`liaison-action-v1\0${token}`).digest("hex");
}

export function normalizeMessagingAddress(value: string): string | null {
  const parsed = parsePhoneNumberFromString(value.trim(), "US");
  return parsed?.isValid() ? parsed.number : null;
}
