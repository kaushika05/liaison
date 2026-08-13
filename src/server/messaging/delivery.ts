export const KNOWN_DELIVERY_STATUSES = [
  "unknown",
  "accepted",
  "scheduled",
  "queued",
  "receiving",
  "sending",
  "sent",
  "delivered",
  "received",
  "read",
  "canceled",
  "partially_delivered",
  "undelivered",
  "failed",
] as const;

export type KnownDeliveryStatus = (typeof KNOWN_DELIVERY_STATUSES)[number];

export interface MessageDeliveryEvent {
  status: string;
  observedAt: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface DeliveryFailure {
  status: string;
  observedAt: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface MessageDeliveryState {
  status: string;
  statusAt: string;
  lastEventAt: string;
  failure?: DeliveryFailure;
}

const statusRank: Readonly<Record<KnownDeliveryStatus, number>> = {
  unknown: 0,
  accepted: 10,
  scheduled: 15,
  queued: 20,
  receiving: 25,
  sending: 30,
  sent: 40,
  delivered: 50,
  received: 55,
  read: 60,
  canceled: 90,
  partially_delivered: 91,
  undelivered: 92,
  failed: 93,
};

const failureStatuses = new Set<string>([
  "canceled",
  "partially_delivered",
  "undelivered",
  "failed",
]);

export function normalizeDeliveryStatus(status: string): string {
  const normalized = status.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return normalized || "unknown";
}

export function isDeliveryFailure(status: string): boolean {
  return failureStatuses.has(normalizeDeliveryStatus(status));
}

export function isTerminalDeliveryStatus(status: string): boolean {
  const normalized = normalizeDeliveryStatus(status);
  return failureStatuses.has(normalized) || normalized === "delivered" || normalized === "received" || normalized === "read";
}

function rank(status: string): number {
  return statusRank[status as KnownDeliveryStatus] ?? 0;
}

function earliest(left: string, right: string): string {
  return left <= right ? left : right;
}

function latest(left: string, right: string): string {
  return left >= right ? left : right;
}

function failurePreference(failure: DeliveryFailure): string {
  const detailScore = `${failure.errorCode ? "1" : "0"}${failure.errorMessage ? "1" : "0"}`;
  return `${detailScore}:${rank(failure.status).toString().padStart(3, "0")}:${failure.errorCode ?? ""}:${failure.errorMessage ?? ""}`;
}

function selectFailure(current: DeliveryFailure | undefined, candidate: DeliveryFailure | undefined): DeliveryFailure | undefined {
  if (!current) return candidate;
  if (!candidate) return current;
  const currentPreference = failurePreference(current);
  const candidatePreference = failurePreference(candidate);
  if (currentPreference === candidatePreference) {
    return { ...current, observedAt: earliest(current.observedAt, candidate.observedAt) };
  }
  return candidatePreference > currentPreference ? candidate : current;
}

/**
 * Reduces provider callbacks by semantic progression instead of arrival order.
 * Terminal failures outrank success and retain their diagnostic details, so a
 * late queued/sent callback cannot erase a failure already observed.
 */
export function reduceMessageDelivery(
  current: MessageDeliveryState | undefined,
  event: MessageDeliveryEvent,
): MessageDeliveryState {
  const status = normalizeDeliveryStatus(event.status);
  const candidateFailure: DeliveryFailure | undefined = isDeliveryFailure(status)
    ? {
        status,
        observedAt: event.observedAt,
        ...(event.errorCode ? { errorCode: event.errorCode } : {}),
        ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
      }
    : undefined;

  if (!current) {
    return {
      status,
      statusAt: event.observedAt,
      lastEventAt: event.observedAt,
      ...(candidateFailure ? { failure: candidateFailure } : {}),
    };
  }

  const currentStatus = normalizeDeliveryStatus(current.status);
  const shouldAdvance = rank(status) > rank(currentStatus);
  const sameStatus = status === currentStatus;
  return {
    status: shouldAdvance ? status : currentStatus,
    statusAt: shouldAdvance
      ? event.observedAt
      : sameStatus
        ? earliest(current.statusAt, event.observedAt)
        : current.statusAt,
    lastEventAt: latest(current.lastEventAt, event.observedAt),
    ...(selectFailure(current.failure, candidateFailure)
      ? { failure: selectFailure(current.failure, candidateFailure) }
      : {}),
  };
}
