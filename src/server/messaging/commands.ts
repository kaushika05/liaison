export type MessagingCommand =
  | {
      kind:
        | "START"
        | "STOP"
        | "HELP"
        | "NEW"
        | "STATUS"
        | "LINK"
        | "EDIT"
        | "CANCEL"
        | "PAUSE"
        | "RESUME"
        | "APPROVE_PLAN";
    }
  | { kind: "CALL"; code: string }
  | { kind: "MODE"; mode: "ASSIST" | "COPILOT" | "DELEGATE" }
  | { kind: "CHOICE"; code: "A" | "B" | "C" }
  | { kind: "HANGUP_REQUEST" }
  | { kind: "HANGUP_CONFIRM" }
  | { kind: "EXACT_SPEECH"; text: string };

const simple = new Set([
  "START",
  "STOP",
  "HELP",
  "NEW",
  "STATUS",
  "LINK",
  "EDIT",
  "CANCEL",
  "PAUSE",
  "RESUME",
] as const);

/** Commands are parsed before any model or natural-language classifier. */
export function parseMessagingCommand(input: string): MessagingCommand | null {
  const text = input.trim();
  if (!text) return null;
  const upper = text.toUpperCase();
  if (upper === "APPROVE" || upper === "APPROVE PLAN") return { kind: "APPROVE_PLAN" };
  if (simple.has(upper as typeof simple extends Set<infer T> ? T : never))
    return { kind: upper as Extract<MessagingCommand, { kind: string }>["kind"] } as MessagingCommand;
  if (/^[ABC]$/.test(upper)) return { kind: "CHOICE", code: upper as "A" | "B" | "C" };
  if (upper === "HANGUP") return { kind: "HANGUP_REQUEST" };
  if (/^HANGUP\s+YES$/.test(upper)) return { kind: "HANGUP_CONFIRM" };
  const call = /^CALL\s+([A-Z0-9]{4,8})$/i.exec(text);
  if (call) return { kind: "CALL", code: call[1].toUpperCase() };
  const mode = /^MODE\s+(ASSIST|COPILOT|DELEGATE)$/i.exec(text);
  if (mode) return { kind: "MODE", mode: mode[1].toUpperCase() as "ASSIST" | "COPILOT" | "DELEGATE" };
  const speech = /^SAY:\s*(.+)$/is.exec(text);
  if (speech) return { kind: "EXACT_SPEECH", text: speech[1].trim() };
  return null;
}

export const conciseCommandHelp = [
  "NEW - begin a support request",
  "STATUS - current progress",
  "EDIT or LINK - open the secure web app",
  "CALL <code> - start the approved plan",
  "PAUSE / RESUME - control agent replies",
  "HANGUP - request call termination",
  "MODE ASSIST, COPILOT, or DELEGATE",
  "STOP - opt out of messages; it does not end a call",
].join("\n");
