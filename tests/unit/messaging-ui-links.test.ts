import { describe, expect, it } from "vitest";
import {
  findSameOriginActionHref,
  safeSameOriginActionHref,
  safeSameOriginCallHref,
  sameOriginActionLinkParts,
  sameOriginCallLinkParts,
} from "../../src/client/message-links.js";

const origin = "https://liaison.example";
const token = "AbCdEfGhIjKlMnOpQrStUvWxYz_12345";
const path = `/a/${token}`;

describe("messaging UI secure-action links", () => {
  it("accepts only token-shaped action routes on the current origin", () => {
    expect(safeSameOriginActionHref(path, origin)).toBe(path);
    expect(safeSameOriginActionHref(`${origin}${path}`, origin)).toBe(path);
    expect(safeSameOriginActionHref(`/a/too-short`, origin)).toBeNull();
    expect(safeSameOriginActionHref(`${path}?redirect=https://evil.example`, origin)).toBeNull();
    expect(safeSameOriginActionHref(`${path}#fragment`, origin)).toBeNull();
  });

  it("does not linkify action-shaped paths on external origins", () => {
    expect(safeSameOriginActionHref(`https://evil.example${path}`, origin)).toBeNull();
    expect(safeSameOriginActionHref(`https://liaison.example.evil.test${path}`, origin)).toBeNull();
    expect(findSameOriginActionHref(`Review https://evil.example${path} now`, origin)).toBeNull();
    expect(findSameOriginActionHref("Documentation: https://example.com/help", origin)).toBeNull();
  });

  it("preserves surrounding punctuation while identifying a safe action link", () => {
    expect(sameOriginActionLinkParts(`(${origin}${path}).`, origin)).toEqual({ prefix: "(", href: path, suffix: ")." });
    expect(findSameOriginActionHref(`Open the secure app: ${origin}${path}.`, origin)).toBe(path);
  });

  it("linkifies only authenticated in-app call outcome routes", () => {
    const callPath = "/calls/00000000-0000-4000-8000-000000000001";
    expect(safeSameOriginCallHref(callPath, origin)).toBe(callPath);
    expect(safeSameOriginCallHref(`${origin}${callPath}`, origin)).toBe(callPath);
    expect(sameOriginCallLinkParts(`(${origin}${callPath}).`, origin)).toEqual({
      prefix: "(",
      href: callPath,
      suffix: ").",
    });
    expect(safeSameOriginCallHref(`https://evil.example${callPath}`, origin)).toBeNull();
    expect(safeSameOriginCallHref("/calls/not-a-call-id", origin)).toBeNull();
    expect(safeSameOriginCallHref(`${callPath}?download=true`, origin)).toBeNull();
  });
});
