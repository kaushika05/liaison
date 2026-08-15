import twilio from "twilio";
import type { WebSocket } from "ws";
import type { Config } from "../config.js";

export type EndReason =
  | "RESOLVED"
  | "PARTIALLY_RESOLVED"
  | "UNRESOLVED"
  | "REPRESENTATIVE_REFUSED_AUTOMATION"
  | "AUTHENTICATION_REQUIRED"
  | "USER_REQUESTED"
  | "TECHNICAL_FAILURE"
  | "POLICY_BLOCKED";
export interface StartCallInput {
  callId: string;
  destination: string;
  signedToken: string;
}
export interface StartCallResult {
  providerCallId: string;
}
export interface SpeakOptions {
  interruptible?: boolean;
}
export class AmbiguousProviderCallStartError extends Error {
  constructor(cause: unknown) {
    super("AMBIGUOUS_PROVIDER_CALL_START", { cause });
    this.name = "AmbiguousProviderCallStartError";
  }
}
export interface TelephonyAdapter {
  startCall(input: StartCallInput): Promise<StartCallResult>;
  speak(callId: string, text: string, options?: SpeakOptions): Promise<void>;
  sendDigits(callId: string, digits: string): Promise<void>;
  pauseAgent(callId: string): Promise<void>;
  resumeAgent(callId: string): Promise<void>;
  endCall(callId: string, reason: EndReason): Promise<void>;
}

export class SimulatedTelephonyAdapter implements TelephonyAdapter {
  readonly actions: Array<{ callId: string; type: string; value?: string }> = [];
  async startCall(input: StartCallInput): Promise<StartCallResult> {
    this.actions.push({ callId: input.callId, type: "start", value: input.destination });
    return { providerCallId: `SIM-${input.callId}` };
  }
  async speak(callId: string, text: string): Promise<void> {
    this.actions.push({ callId, type: "speak", value: text });
  }
  async sendDigits(callId: string, digits: string): Promise<void> {
    this.actions.push({ callId, type: "digits", value: digits });
  }
  async pauseAgent(callId: string): Promise<void> {
    this.actions.push({ callId, type: "pause" });
  }
  async resumeAgent(callId: string): Promise<void> {
    this.actions.push({ callId, type: "resume" });
  }
  async endCall(callId: string, reason: EndReason): Promise<void> {
    this.actions.push({ callId, type: "end", value: reason });
  }
}

export class TwilioConversationRelayAdapter implements TelephonyAdapter {
  private readonly client: ReturnType<typeof twilio>;
  private readonly sockets = new Map<string, WebSocket>();
  private readonly providerIds = new Map<string, string>();
  constructor(private readonly config: Config) {
    this.client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
  }
  async startCall(input: StartCallInput): Promise<StartCallResult> {
    const token = encodeURIComponent(input.signedToken);
    let call: { sid: string };
    try {
      call = await this.client.calls.create({
        to: input.destination,
        from: this.config.TWILIO_FROM_NUMBER,
        url: `${this.config.PUBLIC_BASE_URL}/webhooks/twilio/voice/${token}`,
        method: "POST",
        record: false,
        statusCallback: `${this.config.PUBLIC_BASE_URL}/webhooks/twilio/status/${token}`,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        timeout: Math.min(60, Math.max(10, Math.floor(this.config.MAX_CALL_DURATION_MINUTES * 2))),
      });
    } catch (error) {
      const status =
        typeof error === "object" && error !== null && "status" in error
          ? Number((error as { status?: unknown }).status)
          : 0;
      if (!status || status >= 500) throw new AmbiguousProviderCallStartError(error);
      throw error;
    }
    this.providerIds.set(input.callId, call.sid);
    return { providerCallId: call.sid };
  }
  /**
   * Binds a provider call SID discovered after `startCall` returned — the ambiguous-start path,
   * where the Calls API response was lost but a signed callback later identifies the same call.
   * Without this the adapter would hold no SID and `endCall` would silently decline to terminate
   * a call that is genuinely connected.
   */
  bindProviderCallId(callId: string, providerCallId: string): void {
    this.providerIds.set(callId, providerCallId);
  }
  attachSocket(callId: string, socket: WebSocket): void {
    this.sockets.set(callId, socket);
    socket.once("close", () => {
      if (this.sockets.get(callId) === socket) this.sockets.delete(callId);
    });
  }
  private send(callId: string, payload: object): void {
    const socket = this.sockets.get(callId);
    if (!socket || socket.readyState !== socket.OPEN) throw new Error("TWILIO_RELAY_NOT_CONNECTED");
    socket.send(JSON.stringify(payload));
  }
  async speak(callId: string, text: string, options?: SpeakOptions): Promise<void> {
    this.send(callId, {
      type: "text",
      token: text,
      last: true,
      interruptible: options?.interruptible ?? true,
      preemptible: false,
    });
  }
  async sendDigits(callId: string, digits: string): Promise<void> {
    this.send(callId, { type: "sendDigits", digits });
  }
  async pauseAgent(callId: string): Promise<void> {
    void callId; /* Application-level pause; transcription remains connected. */
  }
  async resumeAgent(callId: string): Promise<void> {
    void callId; /* Application-level resume. */
  }
  async endCall(callId: string, reason: EndReason): Promise<void> {
    const socket = this.sockets.get(callId);
    const relayOpen = Boolean(socket && socket.readyState === socket.OPEN);
    if (relayOpen) socket!.send(JSON.stringify({ type: "end", handoffData: JSON.stringify({ reasonCode: reason }) }));
    const sid = this.providerIds.get(callId);
    // Neither a provider SID nor an open relay means there is no channel through which this call can
    // actually be terminated. Reporting success would let the caller record a completed hang-up while
    // the telephone call continues, so surface it as an ambiguous termination instead.
    if (!sid && !relayOpen) throw new Error("TWILIO_CALL_TERMINATION_CHANNEL_UNAVAILABLE");
    if (sid) await this.client.calls(sid).update({ status: "completed" });
    this.sockets.delete(callId);
    this.providerIds.delete(callId);
  }
  async endOrphanedCall(providerCallId: string): Promise<void> {
    await this.client.calls(providerCallId).update({ status: "completed" });
  }
}
