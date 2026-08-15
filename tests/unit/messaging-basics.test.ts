import { describe, expect, it } from "vitest";
import { parseMessagingCommand } from "../../src/server/messaging/commands.js";
import { composeSms, estimateSmsSegments } from "../../src/server/messaging/composer.js";
import { redactInboundSmsSecrets } from "../../src/server/messaging/secrets.js";

describe("messaging command parser", () => {
  it("matches deterministic commands exactly and case-insensitively", () => {
    expect(parseMessagingCommand(" status ")).toEqual({ kind: "STATUS" });
    expect(parseMessagingCommand("CALL 4k7p")).toEqual({ kind: "CALL", code: "4K7P" });
    expect(parseMessagingCommand("mode delegate")).toEqual({ kind: "MODE", mode: "DELEGATE" });
    expect(parseMessagingCommand("B")).toEqual({ kind: "CHOICE", code: "B" });
    expect(parseMessagingCommand("hangup")).toEqual({ kind: "HANGUP_REQUEST" });
    expect(parseMessagingCommand("HANGUP YES")).toEqual({ kind: "HANGUP_CONFIRM" });
    expect(parseMessagingCommand("SAY: Ask for a supervisor.")).toEqual({
      kind: "EXACT_SPEECH",
      text: "Ask for a supervisor.",
    });
    expect(parseMessagingCommand("okay")).toBeNull();
    expect(parseMessagingCommand("please CALL 4K7P")).toBeNull();
  });
});

describe("SMS segmentation and composition", () => {
  it("accounts for GSM extension characters and UCS-2", () => {
    expect(estimateSmsSegments("a".repeat(160))).toMatchObject({ encoding: "GSM-7", segments: 1 });
    expect(estimateSmsSegments("^".repeat(81))).toMatchObject({ encoding: "GSM-7", segments: 2, units: 162 });
    expect(estimateSmsSegments("🙂".repeat(36))).toMatchObject({ encoding: "UCS-2", segments: 2, units: 72 });
  });
  it("drops background detail but preserves critical choices, amounts, deadlines, and links", () => {
    const result = composeSms({
      action: "DECISION NEEDED - 90 seconds\nA - Negotiate\nB - Accept $20\nC - Supervisor",
      summary: "They offered $20.",
      details: ["x".repeat(900)],
      secureLink: "https://example.test/a/opaque",
      requiredFragments: ["A -", "$20", "90 seconds", "opaque"],
      maxSegments: 3,
    });
    expect(result.compressed).toBe(true);
    expect(result.estimate.segments).toBeLessThanOrEqual(3);
    expect(result.body).not.toContain("x".repeat(200));
  });
  it("retains required command lines that occur after a long plan summary", () => {
    const result = composeSms({
      summary: [
        "PLAN 3 - REVIEW REQUIRED",
        `Background: ${"x".repeat(900)}`,
        "Reply APPROVE PLAN to create a one-time code.",
        "Reply EDIT to change it.",
        "Secure app: https://example.test/",
      ].join("\n"),
      requiredFragments: ["APPROVE PLAN", "EDIT", "https://example.test/"],
      maxSegments: 3,
    });
    expect(result.compressed).toBe(true);
    expect(result.body).toContain("APPROVE PLAN");
    expect(result.body).toContain("EDIT");
    expect(result.body).toContain("https://example.test/");
    expect(result.estimate.segments).toBeLessThanOrEqual(3);
  });
});

describe("inbound SMS credential redaction", () => {
  it.each([
    ["my password is hunter2", "hunter2", "PASSWORD"],
    ["OTP: 482911", "482911", "ONE_TIME_CODE"],
    ["my pin is 0442", "0442", "PIN"],
    ["SSN is 123-45-6789", "123-45-6789", "SOCIAL_SECURITY_NUMBER"],
    ["card number is 4111 1111 1111 1111", "4111", "PAYMENT_CARD"],
  ])("redacts %s", (raw, secret, category) => {
    const result = redactInboundSmsSecrets(raw);
    expect(result.blocked).toBe(true);
    expect(result.redactedText).not.toContain(secret);
    expect(result.categories).toContain(category);
  });
  it("does not treat an ordinary refund amount as a credential", () =>
    expect(redactInboundSmsSecrets("I need a $35 refund").blocked).toBe(false));
  it("preserves instructions about a one-time call code when no value is present", () =>
    expect(redactInboundSmsSecrets("Reply APPROVE PLAN to create a one-time call code.")).toEqual({
      redactedText: "Reply APPROVE PLAN to create a one-time call code.",
      categories: [],
      blocked: false,
    }));
  it("still redacts labeled one-time code values", () =>
    expect(redactInboundSmsSecrets("Your one-time code is 482911")).toMatchObject({
      redactedText: "Your [REDACTED_PROHIBITED_ONE_TIME_CODE]",
      categories: ["ONE_TIME_CODE"],
      blocked: true,
    }));
});
