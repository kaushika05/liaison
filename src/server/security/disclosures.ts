import { randomUUID } from "node:crypto";
import type { DisclosureCardMetadata } from "../../shared/domain.js";
import { disclosureCardMetadataSchema, intakeDisclosureSchema } from "../../shared/domain.js";
import { prohibitedSecretReason } from "../core/policy.js";

interface StoredSecret { metadata: DisclosureCardMetadata; value: string }

export class DisclosureStore {
  private readonly byCase = new Map<string, Map<string, StoredSecret>>();
  createForCase(caseId: string, cards: unknown[]): DisclosureCardMetadata[] {
    const values = new Map<string, StoredSecret>();
    const metadata = cards.map((candidate) => {
      const card = intakeDisclosureSchema.parse(candidate);
      if (/password|one.?time|otp|security answer|full ssn|social security|payment card|credit card|cvv|\bpin\b|private key|recovery code/i.test(card.label)) throw new Error("PROHIBITED_DISCLOSURE_CATEGORY");
      const secretReason = prohibitedSecretReason(card.value);
      if (secretReason) throw new Error(`PROHIBITED_DISCLOSURE_VALUE:${secretReason}`);
      const item = disclosureCardMetadataSchema.parse({ ...card, id: randomUUID(), redactInLogs: true });
      const { value: _removed, ...meta } = { ...item, value: card.value };
      void _removed;
      values.set(item.id, { metadata: meta, value: card.value });
      return meta;
    });
    this.byCase.set(caseId, values);
    return metadata;
  }
  metadata(caseId: string): DisclosureCardMetadata[] { return [...(this.byCase.get(caseId)?.values() ?? [])].map((entry) => entry.metadata); }
  resolve(caseId: string, cardId: string, channel: "SPEECH"|"DTMF"): StoredSecret | null {
    const entry = this.byCase.get(caseId)?.get(cardId) ?? null;
    if (!entry || entry.metadata.permission !== "ASK" || !entry.metadata.allowedChannels.includes(channel)) return null;
    return entry;
  }
  redactionInputs(caseId: string): Array<{label:string;category:string;value:string}> { return [...(this.byCase.get(caseId)?.values() ?? [])].map((entry)=>({label:entry.metadata.label,category:entry.metadata.category,value:entry.value})); }
  clearCase(caseId: string): void { this.byCase.delete(caseId); }
  clearAll(): void { this.byCase.clear(); }
}
