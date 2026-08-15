const actionTokenPattern = /^[A-Za-z0-9_-]{20,200}$/;
const callIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function candidateParts(part: string): { prefix: string; candidate: string; suffix: string } {
  const prefix = part.match(/^[([{'"<]+/)?.[0] ?? "";
  const withoutPrefix = part.slice(prefix.length);
  const suffix = withoutPrefix.match(/[\])}'">,.!?;:]+$/)?.[0] ?? "";
  return { prefix, candidate: withoutPrefix.slice(0, withoutPrefix.length - suffix.length), suffix };
}

/** Returns a same-origin, token-shaped Liaison action path or null. External and malformed URLs remain plain text. */
export function safeSameOriginActionHref(candidate: string, origin: string): string | null {
  try {
    const expectedOrigin = new URL(origin);
    const url = new URL(candidate, expectedOrigin);
    const match = url.pathname.match(/^\/a\/([^/]+)\/?$/);
    if (
      url.origin !== expectedOrigin.origin ||
      url.protocol !== expectedOrigin.protocol ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !match ||
      !actionTokenPattern.test(match[1])
    )
      return null;
    return `/a/${match[1]}`;
  } catch {
    return null;
  }
}

export function sameOriginActionLinkParts(
  part: string,
  origin: string,
): { prefix: string; href: string; suffix: string } | null {
  const { prefix, candidate, suffix } = candidateParts(part);
  const href = safeSameOriginActionHref(candidate, origin);
  return href ? { prefix, href, suffix } : null;
}

/** Returns a same-origin Liaison call route or null. It never linkifies arbitrary or external URLs. */
export function safeSameOriginCallHref(candidate: string, origin: string): string | null {
  try {
    const expectedOrigin = new URL(origin);
    const url = new URL(candidate, expectedOrigin);
    const match = url.pathname.match(/^\/calls\/([^/]+)\/?$/);
    if (
      url.origin !== expectedOrigin.origin ||
      url.protocol !== expectedOrigin.protocol ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !match ||
      !callIdPattern.test(match[1])
    )
      return null;
    return `/calls/${match[1]}`;
  } catch {
    return null;
  }
}

export function sameOriginCallLinkParts(
  part: string,
  origin: string,
): { prefix: string; href: string; suffix: string } | null {
  const { prefix, candidate, suffix } = candidateParts(part);
  const href = safeSameOriginCallHref(candidate, origin);
  return href ? { prefix, href, suffix } : null;
}

/** Finds only action links that resolve to the supplied app origin. */
export function findSameOriginActionHref(text: string, origin: string): string | null {
  for (const part of text.split(/\s+/)) {
    const match = sameOriginActionLinkParts(part, origin);
    if (match) return match.href;
  }
  return null;
}
