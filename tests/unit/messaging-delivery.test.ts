import { describe, expect, it } from "vitest";
import {
  isDeliveryFailure,
  isTerminalDeliveryStatus,
  normalizeDeliveryStatus,
  reduceMessageDelivery,
} from "../../src/server/messaging/delivery.js";

describe("Twilio delivery reducer", () => {
  it("advances through delivery and ignores duplicate or late regressions", () => {
    const queued = reduceMessageDelivery(undefined, { status: "queued", observedAt: "2026-08-12T12:00:00.000Z" });
    const delivered = reduceMessageDelivery(queued, { status: "DELIVERED", observedAt: "2026-08-12T12:00:03.000Z" });
    const duplicate = reduceMessageDelivery(delivered, { status: "delivered", observedAt: "2026-08-12T12:00:04.000Z" });
    const lateSent = reduceMessageDelivery(duplicate, { status: "sent", observedAt: "2026-08-12T12:00:05.000Z" });
    expect(lateSent).toMatchObject({
      status: "delivered",
      statusAt: "2026-08-12T12:00:03.000Z",
      lastEventAt: "2026-08-12T12:00:05.000Z",
    });
  });

  it("preserves a terminal failure and its diagnostics across out-of-order success callbacks", () => {
    const failed = reduceMessageDelivery(undefined, {
      status: "undelivered",
      observedAt: "2026-08-12T12:00:03.000Z",
      errorCode: "30003",
      errorMessage: "Unreachable destination handset",
    });
    const lateQueued = reduceMessageDelivery(failed, { status: "queued", observedAt: "2026-08-12T12:00:04.000Z" });
    const lateSent = reduceMessageDelivery(lateQueued, { status: "sent", observedAt: "2026-08-12T12:00:05.000Z" });
    expect(lateSent).toMatchObject({
      status: "undelivered",
      statusAt: "2026-08-12T12:00:03.000Z",
      failure: {
        status: "undelivered",
        errorCode: "30003",
        errorMessage: "Unreachable destination handset",
      },
    });
    const laterFailureWithoutDiagnostics = reduceMessageDelivery(lateSent, {
      status: "failed",
      observedAt: "2026-08-12T12:00:06.000Z",
    });
    expect(laterFailureWithoutDiagnostics.status).toBe("failed");
    expect(laterFailureWithoutDiagnostics.failure).toMatchObject({
      status: "undelivered",
      errorCode: "30003",
      errorMessage: "Unreachable destination handset",
    });
  });

  it("normalizes provider spelling and identifies terminal states", () => {
    expect(normalizeDeliveryStatus("Partially-Delivered")).toBe("partially_delivered");
    expect(isDeliveryFailure("FAILED")).toBe(true);
    expect(isDeliveryFailure("delivered")).toBe(false);
    expect(isTerminalDeliveryStatus("read")).toBe(true);
    expect(isTerminalDeliveryStatus("sending")).toBe(false);
  });

  it("handles future statuses without allowing them to regress known progress", () => {
    const future = reduceMessageDelivery(undefined, { status: "carrier_acknowledged", observedAt: "2026-08-12T12:00:00.000Z" });
    expect(future.status).toBe("carrier_acknowledged");
    const sent = reduceMessageDelivery(future, { status: "sent", observedAt: "2026-08-12T12:00:01.000Z" });
    const futureLate = reduceMessageDelivery(sent, { status: "carrier_acknowledged", observedAt: "2026-08-12T12:00:02.000Z" });
    expect(futureLate.status).toBe("sent");
  });
});
