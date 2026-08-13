import { randomUUID } from "node:crypto";
import type { DisclosureCardMetadata } from "../../shared/domain.js";
import { disclosureCardMetadataSchema, intakeDisclosureSchema } from "../../shared/domain.js";
import { prohibitedSecretReason } from "../core/policy.js";

interface StoredSecret { metadata: DisclosureCardMetadata; value: string }

export class DisclosureStore {
  private readonly byCase = new Map<string, Map<string, StoredSecret>>();
  private parse(candidate: unknown): StoredSecret {
    const card = intakeDisclosureSchema.parse(candidate);
    if (/password|one.?time|otp|security answer|full ssn|social security|payment card|credit card|cvv|\bpin\b|private key|recovery code/i.test(card.label)) throw new Error("PROHIBITED_DISCLOSURE_CATEGORY");
    const secretReason = prohibitedSecretReason(card.value);
    if (secretReason) throw new Error(`PROHIBITED_DISCLOSURE_VALUE:${secretReason}`);
    const item = disclosureCardMetadataSchema.parse({ ...card, id: randomUUID(), redactInLogs: true });
    const { value: _removed, ...metadata } = { ...item, value: card.value };
    void _removed;
    return { metadata, value: card.value };
  }
  createForCase(caseId: string, cards: unknown[]): DisclosureCardMetadata[] {
    const values = new Map<string, StoredSecret>();
    const metadata = cards.map((candidate) => {
      const entry = this.parse(candidate);
      values.set(entry.metadata.id, entry);
      return entry.metadata;
    });
    this.byCase.set(caseId, values);
    return metadata;
  }
  addForCase(caseId: string, card: unknown): DisclosureCardMetadata {
    const entry = this.parse(card);
    let values = this.byCase.get(caseId);
    if (!values) {
      values = new Map<string, StoredSecret>();
      this.byCase.set(caseId, values);
    }
    values.set(entry.metadata.id, entry);
    return entry.metadata;
  }
  remove(caseId: string, cardId: string): void {
    const values = this.byCase.get(caseId);
    values?.delete(cardId);
    if (values?.size === 0) this.byCase.delete(caseId);
  }
  metadata(caseId: string): DisclosureCardMetadata[] { return [...(this.byCase.get(caseId)?.values() ?? [])].map((entry) => entry.metadata); }
  resolve(caseId: string, cardId: string, channel: "SPEECH"|"DTMF", purpose: string): StoredSecret | null {
    const entry = this.byCase.get(caseId)?.get(cardId) ?? null;
    const normalized=purpose.normalize("NFKC").toLowerCase();
    const purposeAllowed=entry?.metadata.allowedPurposes.some((allowed)=>{
      const terms=allowed.normalize("NFKC").toLowerCase().split(/[^a-z0-9]+/).filter((term)=>term.length>=4);
      return terms.length>0&&terms.some((term)=>normalized.includes(term));
    })??false;
    if (!entry || entry.metadata.permission !== "ASK" || !entry.metadata.allowedChannels.includes(channel) || !purposeAllowed) return null;
    return entry;
  }
  redactionInputs(caseId: string): Array<{label:string;category:string;value:string}> { return [...(this.byCase.get(caseId)?.values() ?? [])].map((entry)=>({label:entry.metadata.label,category:entry.metadata.category,value:entry.value})); }
  clearCase(caseId: string): void { this.byCase.delete(caseId); }
  clearAll(): void { this.byCase.clear(); }
}
