const gsmBasic = new Set(
  "@\u00a3$\u00a5\u00e8\u00e9\u00f9\u00ec\u00f2\u00c7\n\u00d8\u00f8\r\u00c5\u00e5\u0394_\u03a6\u0393\u039b\u03a9\u03a0\u03a8\u03a3\u0398\u039e \u00c6\u00e6\u00df\u00c9 !\"#\u00a4%&'()*+,-./0123456789:;<=>?\u00a1ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00c4\u00d6\u00d1\u00dc\u00a7\u00bfabcdefghijklmnopqrstuvwxyz\u00e4\u00f6\u00f1\u00fc\u00e0".split(
    "",
  ),
);
const gsmExtended = new Set("^{}\\[~]|\u20ac".split(""));

export interface SegmentEstimate {
  encoding: "GSM-7" | "UCS-2";
  units: number;
  segments: number;
  perSegment: number;
}

export function estimateSmsSegments(text: string): SegmentEstimate {
  let gsmUnits = 0;
  let gsm = true;
  for (const character of text) {
    if (gsmBasic.has(character)) gsmUnits += 1;
    else if (gsmExtended.has(character)) gsmUnits += 2;
    else {
      gsm = false;
      break;
    }
  }

  if (gsm) {
    const segments = gsmUnits <= 160 ? 1 : Math.ceil(gsmUnits / 153);
    return { encoding: "GSM-7", units: gsmUnits, segments, perSegment: segments === 1 ? 160 : 153 };
  }

  const units = [...text].reduce((count, character) => count + (character.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  const segments = units <= 70 ? 1 : Math.ceil(units / 67);
  return { encoding: "UCS-2", units, segments, perSegment: segments === 1 ? 70 : 67 };
}

export interface ComposeSmsInput {
  action?: string;
  summary: string;
  details?: string[];
  secureLink?: string;
  requiredFragments?: string[];
  maxSegments: number;
}

export interface ComposedSms {
  body: string;
  estimate: SegmentEstimate;
  compressed: boolean;
}

function normalizedLines(input: ComposeSmsInput): string[] {
  return [input.action, input.summary, ...(input.details ?? []), input.secureLink]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.replace(/\r/g, "").split("\n"))
    .map((value) => value.trim())
    .filter(Boolean);
}

function withinLimit(body: string, maxSegments: number): boolean {
  return estimateSmsSegments(body).segments <= maxSegments;
}

function truncateLineToFit(line: string, maxSegments: number): string {
  let low = 1;
  let high = line.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${line.slice(0, middle).trimEnd()}...`;
    if (withinLimit(candidate, maxSegments)) {
      best = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}

export function composeSms(input: ComposeSmsInput): ComposedSms {
  const lines = normalizedLines(input);
  const requiredFragments = [...new Set(input.requiredFragments ?? [])];
  const fullBody = lines.join("\n");
  const fullEstimate = estimateSmsSegments(fullBody);
  if (fullEstimate.segments <= input.maxSegments) return { body: fullBody, estimate: fullEstimate, compressed: false };

  const selected = new Set<number>();
  for (const fragment of requiredFragments) {
    const lineIndex = lines.findIndex((line) => line.includes(fragment));
    if (lineIndex === -1) throw new Error("SMS_COMPOSITION_MISSING_REQUIRED_FRAGMENT");
    selected.add(lineIndex);
  }

  const selectedBody = () =>
    [...selected]
      .sort((a, b) => a - b)
      .map((index) => lines[index])
      .join("\n");
  if (!withinLimit(selectedBody(), input.maxSegments)) throw new Error("SMS_REQUIRED_CONTENT_EXCEEDS_SEGMENT_LIMIT");

  for (let index = 0; index < lines.length; index += 1) {
    if (selected.has(index)) continue;
    selected.add(index);
    if (!withinLimit(selectedBody(), input.maxSegments)) selected.delete(index);
  }

  let body = selectedBody();
  if (!body && lines[0]) body = truncateLineToFit(lines[0], input.maxSegments);
  if (!body) throw new Error("SMS_MESSAGE_EXCEEDS_SEGMENT_LIMIT");

  for (const fragment of requiredFragments) {
    if (!body.includes(fragment)) throw new Error("SMS_COMPOSITION_DROPPED_REQUIRED_FRAGMENT");
  }

  const estimate = estimateSmsSegments(body);
  if (estimate.segments > input.maxSegments) throw new Error("SMS_MESSAGE_EXCEEDS_SEGMENT_LIMIT");
  return { body, estimate, compressed: true };
}
