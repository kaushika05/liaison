import {
  AlertTriangle,
  ArrowUpRight,
  Building2,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  ExternalLink,
  Info,
  LockKeyhole,
  MessageSquareText,
  PhoneCall,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Trash2,
  UserRound,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  CaseDetail,
  MessagingAttentionSummary,
  MessagingCommitmentSummary,
  MessagingThreadMessage,
  MessagingThreadSnapshot,
  SecureActionDetail,
} from "../shared/api";
import { api, post } from "./api";
import { findSameOriginActionHref, sameOriginActionLinkParts, sameOriginCallLinkParts } from "./message-links";
import "./messaging.css";

type AutonomyMode = "ASSIST" | "COPILOT" | "DELEGATE";
type ThreadMessage = MessagingThreadMessage & { semanticRole?: "USER" | "AGENT" | "SYSTEM" | "PROVIDER" };
type ProviderKind = ThreadMessage["providerKind"];
type AttentionRequest = MessagingAttentionSummary;
type Commitment = MessagingCommitmentSummary;
type ThreadSnapshot = MessagingThreadSnapshot;
type SecureDisclosureInput = {
  category: "ACCOUNT_NUMBER" | "ORDER_NUMBER" | "ADDRESS" | "DATE_OF_BIRTH";
  value: string;
  allowedChannels: Array<"SPEECH" | "DTMF">;
};

export interface MessagingThreadProps {
  onOpenCase: (id: string) => void;
  onOpenCall: (id: string) => void;
  setGlobalError: (text: string) => void;
}

const activeCallStates = new Set([
  "PREPARING",
  "DIALING",
  "RINGING",
  "CONNECTED",
  "IVR",
  "ON_HOLD",
  "WAITING_FOR_REPRESENTATIVE",
  "DISCLOSING_ASSISTANT",
  "EXPLAINING_ISSUE",
  "AUTHENTICATING",
  "NEGOTIATING",
  "NEEDS_USER",
  "VERIFYING_OUTCOME",
  "DISCLOSURE",
  "ACTIVE",
  "WAITING_FOR_APPROVAL",
  "PAUSED",
  "ENDING",
]);

const labelize = (value: string) => value.replaceAll("_", " ").toLowerCase().replace(/^./, (letter) => letter.toUpperCase());

const formatTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
};

const formatDateTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
};

const formatMoney = (cents: number) => new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
}).format(cents / 100);

const conditionalRuleCondition = (rule: ThreadSnapshot["conditionalAuthorityRules"][number]) => {
  if (rule.comparison === "ANY" || rule.comparison === undefined) return "For any matching request";
  if (rule.amountCents === undefined) return labelize(rule.comparison);
  if (rule.comparison === "AT_LEAST") return `${formatMoney(rule.amountCents)} or more`;
  if (rule.comparison === "AT_MOST") return `${formatMoney(rule.amountCents)} or less`;
  return `Exactly ${formatMoney(rule.amountCents)}`;
};

const conditionalRuleTone = (decision: ThreadSnapshot["conditionalAuthorityRules"][number]["decision"]): "good" | "warn" | "danger" => {
  if (decision === "ALLOW") return "good";
  if (decision === "DENY") return "danger";
  return "warn";
};

const stringFromRecord = (record: Record<string, unknown> | undefined, key: string) => {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
};

const deliveryFailed = (message: ThreadMessage) =>
  message.direction === "OUTBOUND" && (Boolean(message.errorCode) || ["FAILED", "UNDELIVERED"].includes(message.deliveryState.toUpperCase()));

const messageIdentity = (message: ThreadMessage) => {
  if (message.semanticRole) return message.semanticRole;
  if (deliveryFailed(message)) return "PROVIDER" as const;
  return message.direction === "INBOUND" ? "USER" as const : "AGENT" as const;
};

const messageLabel = (message: ThreadMessage) => {
  const identity = messageIdentity(message);
  if (identity === "USER") return "You";
  if (identity === "AGENT") return "Liaison";
  if (identity === "PROVIDER") return "Provider notice";
  return "System";
};

const providerLabel = (provider: ProviderKind) => {
  if (provider === "TWILIO_SMS") return "SMS via Twilio";
  if (provider === "SIMULATOR") return "Local simulator";
  return "Secure web";
};

function Badge({ tone = "neutral", children }: { tone?: "neutral" | "good" | "warn" | "danger"; children: ReactNode }) {
  return <span className={`message-badge ${tone}`}>{children}</span>;
}

function Panel({ title, icon, children, className = "" }: { title: string; icon: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`message-side-panel ${className}`}><header>{icon}<h2>{title}</h2></header>{children}</section>;
}

function MessageBody({ text }: { text: string }) {
  const origin = window.location.origin;
  return <>{text.split(/(\s+)/).map((part, index) => {
    if (!part.trim()) return part;
    const actionLink = sameOriginActionLinkParts(part, origin);
    const callLink = sameOriginCallLinkParts(part, origin);
    const link = actionLink ?? callLink;
    if (!link) return part;
    const label = actionLink ? "Open secure review" : "Open call outcome";
    return <span key={`${index}:${link.href}`}>{link.prefix}<a className="message-body-action-link" href={link.href} aria-label={`${label} in Liaison`}>{label} <ArrowUpRight aria-hidden="true" /></a>{link.suffix}</span>;
  })}</>;
}

function AttentionCard({ attention, secureActionHref, onChoose, busy }: { attention: AttentionRequest; secureActionHref: string | null; onChoose: (code: string) => void; busy: boolean }) {
  const isSecure = attention.secureActionRequired;
  return <section className={`attention-card tier-${attention.tier.toLowerCase()}`} aria-labelledby={`attention-${attention.id}`}>
    <div className="attention-heading">
      <span className="attention-icon" aria-hidden="true">{isSecure ? <LockKeyhole /> : <Info />}</span>
      <div>
        <p className="message-kicker">Needs your attention · {labelize(attention.tier)}</p>
        <h2 id={`attention-${attention.id}`}>{attention.question}</h2>
      </div>
    </div>
    <p className="attention-expiry"><Clock3 aria-hidden="true" /> Expires <time dateTime={attention.expiresAt}>{formatDateTime(attention.expiresAt)}</time></p>
    {isSecure ? secureActionHref ? <a className="secure-action-link" href={secureActionHref}>
      Review securely <ArrowUpRight aria-hidden="true" />
    </a> : null : <div className="attention-choices" aria-label="Available responses">
      {attention.choices.map((choice) => <button key={choice.id} type="button" disabled={busy} onClick={() => onChoose(choice.shortCode)}>
        <span>{choice.shortCode}</span><strong>{choice.label}</strong><small>{choice.effect}</small>
      </button>)}
    </div>}
    {isSecure && !secureActionHref && <p className="message-warning"><AlertTriangle aria-hidden="true" /> This decision requires secure web review; no valid same-origin review link is available.</p>}
  </section>;
}

function SecureActionReview({
  detail,
  resolution,
  busy,
  onDecision,
}: {
  detail: SecureActionDetail;
  resolution: "APPROVED" | "REJECTED" | null;
  busy: boolean;
  onDecision: (decision: "APPROVE" | "REJECT", confirmation: boolean, replacement?: string) => void;
}) {
  const action = detail.attention;
  const material = action.tier === "MATERIAL";
  const [confirmed, setConfirmed] = useState(false);
  const [replacement, setReplacement] = useState("");
  const expired = action.status.toUpperCase() === "EXPIRED";
  const resolved = resolution !== null || action.status.toUpperCase() !== "PENDING";
  const authority = detail.case?.brief?.authority;
  const transcriptEvidence = (detail.call?.transcript ?? [])
    .filter((turn) => turn.speaker === "REMOTE" || turn.speaker === "LIAISON")
    .slice(-4);

  return <section className="secure-review" aria-labelledby="secure-review-title">
    <header>
      <span className="secure-review-mark" aria-hidden="true"><ShieldCheck /></span>
      <div><p className="message-kicker">Secure decision · {labelize(action.tier)}</p><h1 id="secure-review-title">Review this request</h1></div>
    </header>
    <p className="secure-question">{action.question}</p>
    <dl className="secure-review-facts">
      <div><dt>Status</dt><dd>{labelize(action.status)}</dd></div>
      <div><dt>Secure link expires</dt><dd><time dateTime={detail.expiresAt}>{formatDateTime(detail.expiresAt)}</time></dd></div>
      <div><dt>Decision level</dt><dd>{labelize(action.tier)}</dd></div>
    </dl>
    <dl className="secure-action-context">
      <div><dt>Representative request</dt><dd>{detail.representativeRequest}</dd></div>
      <div><dt>Current approved goal</dt><dd>{detail.currentGoal || "No goal is available."}</dd></div>
      <div><dt>Proposed action</dt><dd>{detail.proposedAction}</dd></div>
      <div><dt>Consequence</dt><dd>{detail.consequences}</dd></div>
      {detail.amountCents !== null && <div><dt>Amount</dt><dd>{formatMoney(detail.amountCents)}</dd></div>}
    </dl>
    <section className="secure-review-authority" aria-labelledby="secure-review-authority-title">
      <h2 id="secure-review-authority-title">Current authority</h2>
      {authority ? <>
        <dl>
          <div><dt>Personal-data disclosure</dt><dd>{labelize(authority.disclosePersonalData)}</dd></div>
          <div><dt>Financial outcome</dt><dd>{labelize(authority.acceptFinancialOutcome)}</dd></div>
          <div><dt>Account changes</dt><dd>{labelize(authority.modifyAccount)}</dd></div>
          <div><dt>Maximum authorized cost</dt><dd>{formatMoney(authority.maximumAuthorizedCostCents)}</dd></div>
        </dl>
        <p><ShieldCheck aria-hidden="true" /> Purchases, credentials, one-time codes, full SSNs, payment cards, legal waivers, and impersonation remain prohibited.</p>
        {authority.forbiddenActions.length > 0 && <details><summary>Plan-specific prohibitions</summary><ul>{authority.forbiddenActions.map((item) => <li key={item}>{item}</li>)}</ul></details>}
      </> : <p>No approved authority envelope is available. Approval cannot expand Liaison's hard safety boundaries.</p>}
    </section>
    <section className="secure-review-evidence" aria-labelledby="secure-review-evidence-title">
      <h2 id="secure-review-evidence-title">Recent transcript context</h2>
      <p>Stored transcript text is redacted before it appears in this secure review.</p>
      {transcriptEvidence.length > 0 ? <ol>{transcriptEvidence.map((turn) => <li key={turn.id}><strong>{turn.speaker === "REMOTE" ? "Representative" : "Liaison"}</strong><blockquote>{turn.text}</blockquote></li>)}</ol> : <p>No redacted transcript turns are available for this decision.</p>}
    </section>
    {!detail.approvalPermitted && !resolved && !expired && <p className="message-warning conditional-approval-blocked" role="alert"><ShieldCheck aria-hidden="true" /> Approval is blocked by a condition in the approved plan. You can reject this request or send a replacement response.</p>}
    {material && detail.approvalPermitted && !resolved && !expired && <label className="explicit-confirmation"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span><strong>I understand this is a material decision.</strong> I reviewed the consequence above and intend to approve it.</span></label>}
    {!resolved && !expired && <div className="replacement-field"><label htmlFor="secure-replacement">Prefer a different response? <span>Optional</span></label><textarea id="secure-replacement" rows={3} value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder="Describe the replacement Liaison should use." /></div>}
    {expired && <p className="message-warning" role="status"><Clock3 aria-hidden="true" /> This secure link has expired. Return to the thread for a new request.</p>}
    {resolved && <p className="message-success" role="status"><CheckCircle2 aria-hidden="true" /> This request {resolution ? `was ${resolution.toLowerCase()}` : `is ${labelize(action.status)}`}.</p>}
    {!resolved && !expired && <div className="secure-review-actions">
      <button type="button" disabled={busy} onClick={() => onDecision("REJECT", confirmed, replacement.trim() || undefined)}>{replacement.trim() ? "Reject and send replacement" : "Reject"}</button>
      {detail.approvalPermitted && <button type="button" className="primary" disabled={busy || (material && !confirmed)} onClick={() => onDecision("APPROVE", confirmed)}>{busy ? "Submitting…" : "Approve"}</button>}
    </div>}
    <p className="secure-review-note"><LockKeyhole aria-hidden="true" /> This link is intended for one decision and cannot be reused after it is resolved.</p>
  </section>;
}

function MessageItem({ message }: { message: ThreadMessage }) {
  const identity = messageIdentity(message);
  const failed = deliveryFailed(message);
  const blocked = message.direction === "INBOUND" && Boolean(message.errorCode);
  return <li className={`thread-message role-${identity.toLowerCase()}${failed ? " delivery-failed" : ""}`}>
    <article aria-label={`${messageLabel(message)} message at ${formatTime(message.createdAt)}`}>
      <header><strong>{messageLabel(message)}</strong><time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time></header>
      <p><MessageBody text={message.redactedBody} /></p>
      <footer>
        <span>{providerLabel(message.providerKind)}</span>
        {message.processingState && message.processingState !== "PROCESSED" && <span>Processing: {labelize(message.processingState)}</span>}
        {message.deliveryState && <span>Delivery: {labelize(message.deliveryState)}</span>}
      </footer>
      {failed && <p className="delivery-error" role="alert"><WifiOff aria-hidden="true" /> Delivery failed{message.errorCode ? ` (${message.errorCode})` : ""}. The message remains visible here; check provider setup before retrying.</p>}
      {blocked && <p className="message-blocked" role="status"><ShieldCheck aria-hidden="true" /> This inbound message was not processed ({message.errorCode}). Review Liaison’s safety reply in the thread.</p>}
    </article>
  </li>;
}

function CommitmentsPanel({ commitments }: { commitments: Commitment[] }) {
  const groups = [
    { key: "COMPANY", label: "Company" },
    { key: "USER", label: "You" },
    { key: "AGENT", label: "Liaison" },
    { key: "UNRESOLVED", label: "Unresolved" },
  ];
  return <Panel title="Commitments" icon={<CheckCircle2 aria-hidden="true" />}>
    {commitments.length === 0 ? <p className="message-muted">No grounded commitments have been recorded.</p> : <div className="commitment-groups">
      {groups.map((group) => {
        const entries = commitments.filter((item) => item.party.toUpperCase() === group.key || (group.key === "UNRESOLVED" && !["COMPANY", "USER", "AGENT"].includes(item.party.toUpperCase())));
        if (entries.length === 0) return null;
        return <section key={group.key}><h3>{group.label}</h3><ul>{entries.map((entry) => <li key={entry.id}>
          <div><strong>{entry.description}</strong><Badge tone={entry.status.toUpperCase() === "CONFIRMED" ? "good" : "neutral"}>{labelize(entry.status)}</Badge></div>
          {(entry.amountCents !== null || entry.deadline || entry.recurring !== null) && <p>{entry.amountCents !== null ? formatMoney(entry.amountCents) : ""}{entry.amountCents !== null && entry.deadline ? " · " : ""}{entry.deadline ? `Due ${formatDateTime(entry.deadline)}` : ""}{entry.recurring !== null ? `${entry.amountCents !== null || entry.deadline ? " · " : ""}${entry.recurring ? "Recurring" : "One-time"}` : ""}</p>}
          {entry.evidence.length > 0 && <details className="commitment-evidence"><summary>Grounding evidence ({entry.evidence.length})</summary><ol>{entry.evidence.map((evidence) => <li key={`${evidence.turnId}:${evidence.exactQuote}`}><blockquote>“{evidence.exactQuote}”</blockquote><span>Transcript turn {evidence.turnId}</span></li>)}</ol></details>}
        </li>)}</ul></section>;
      })}
    </div>}
  </Panel>;
}

function CasePanel({ snapshot, onOpenCase, onOpenCall, onMode, onDeleteCase, onAddDisclosure }: {
  snapshot: ThreadSnapshot;
  onOpenCase: (id: string) => void;
  onOpenCall: (id: string) => void;
  onMode: (mode: AutonomyMode) => void;
  onDeleteCase: (id: string) => Promise<void>;
  onAddDisclosure: (caseId: string, input: SecureDisclosureInput) => Promise<void>;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  const [deleteAcknowledged, setDeleteAcknowledged] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [disclosureCategory, setDisclosureCategory] = useState<SecureDisclosureInput["category"]>("ACCOUNT_NUMBER");
  const [disclosureValue, setDisclosureValue] = useState("");
  const [speechAllowed, setSpeechAllowed] = useState(false);
  const [dtmfAllowed, setDtmfAllowed] = useState(true);
  const [addingDisclosure, setAddingDisclosure] = useState(false);
  const caseItem = snapshot.case;
  const call = snapshot.call;
  const activeCall = Boolean(call && activeCallStates.has(call.state.toUpperCase()));
  const authority = caseItem?.brief?.authority;
  const commitmentCeiling = authority ? formatMoney(authority.maximumAuthorizedCostCents) : "Not granted";
  const alwaysAsk = [
    authority?.acceptFinancialOutcome === "ASK" ? "Accept a financial outcome" : "",
    authority?.acceptAlternativeOutcome === "ASK" ? "Accept an alternative outcome" : "",
    authority?.modifyAccount === "ASK" ? "Modify the account" : "",
    authority?.cancelService === "ASK" ? "Cancel service" : "",
    authority?.scheduleCommitment === "ASK" ? "Schedule a commitment" : "",
  ].filter(Boolean);
  const goal = caseItem?.brief?.desiredOutcome || stringFromRecord(caseItem?.intake, "desiredOutcome") || caseItem?.title || "Still gathering the goal";
  const estimatedCallCost = call?.estimatedCostUsd;
  return <>
    <Panel title="Current case" icon={<Building2 aria-hidden="true" />} className="case-summary-panel">
      {caseItem ? <>
        <p className="case-company-name">{caseItem.companyName}</p>
        <p className="case-goal">{goal}</p>
        <dl className="case-facts">
          <div><dt>Case state</dt><dd>{labelize(caseItem.status)}</dd></div>
          <div><dt>Approved plan</dt><dd>{caseItem.approvedVersion === null ? "Not yet approved" : `Version ${caseItem.approvedVersion}`}</dd></div>
          <div><dt>Call</dt><dd>{call ? labelize(call.state) : "Not active"}</dd></div>
          <div><dt>Estimated call cost</dt><dd>{estimatedCallCost === undefined ? `Up to $${(snapshot.configuration.estimatedCostPerMinuteUsd * snapshot.configuration.maxDurationMinutes).toFixed(2)} configured` : `$${estimatedCallCost.toFixed(2)} so far`}</dd></div>
        </dl>
        <div className="panel-actions"><button type="button" onClick={() => onOpenCase(caseItem.id)}>Open case plan <ExternalLink aria-hidden="true" /></button>{call && <button type="button" onClick={() => onOpenCall(call.id)}>{activeCall ? "Open call cockpit" : "Open call outcome"} <PhoneCall aria-hidden="true" /></button>}<button type="button" className="case-delete-toggle" disabled={activeCall || deleting} onClick={() => setDeleteOpen((value) => !value)}><span>{activeCall ? "End the call before deleting" : "Delete case data"}</span><Trash2 aria-hidden="true" /></button></div>
        {deleteOpen && !activeCall && <section className="case-delete-confirmation" role="group" aria-labelledby="case-delete-title">
          <h3 id="case-delete-title">Permanently delete this case?</h3>
          <p>This removes the case, calls, transcript, message history, secure links, and the intake draft from this deployment. SMS opt-out status is retained.</p>
          <label htmlFor="case-delete-text">Type <strong>DELETE</strong> to continue<input id="case-delete-text" type="text" autoComplete="off" value={deleteText} onChange={(event) => setDeleteText(event.target.value)} /></label>
          <label className="case-delete-check"><input type="checkbox" checked={deleteAcknowledged} onChange={(event) => setDeleteAcknowledged(event.target.checked)} /><span>I understand this local data cannot be recovered after deletion.</span></label>
          <div><button type="button" onClick={() => { setDeleteOpen(false); setDeleteText(""); setDeleteAcknowledged(false); }}>Cancel</button><button type="button" className="danger" disabled={deleting || deleteText !== "DELETE" || !deleteAcknowledged} onClick={() => {
            setDeleting(true);
            void onDeleteCase(caseItem.id).then(() => {
              setDeleteOpen(false);
              setDeleteText("");
              setDeleteAcknowledged(false);
            }).catch(() => undefined).finally(() => setDeleting(false));
          }}>{deleting ? "Deleting..." : "Delete permanently"}</button></div>
        </section>}
      </> : <p className="message-muted">Describe the company and problem in the thread. Liaison will ask only for information it still needs.</p>}
      <label className="mode-select" htmlFor="autonomy-mode"><span>Autonomy mode</span><small>Changing this sends an inspectable MODE command.</small><select id="autonomy-mode" value={snapshot.thread.autonomyMode} onChange={(event) => onMode(event.target.value as AutonomyMode)}><option value="ASSIST">Assist</option><option value="COPILOT">Copilot</option><option value="DELEGATE">Delegate</option></select></label>
    </Panel>
    <Panel title="Authority boundary" icon={<ShieldCheck aria-hidden="true" />}>
      {!authority ? <p className="message-muted">Authority is not set until a call plan exists. Liaison cannot make prohibited or unapproved commitments.</p> : <ul className="authority-list">
        <li><span>Financial outcomes</span><strong>{labelize(authority.acceptFinancialOutcome)}</strong></li>
        <li><span>Account changes</span><strong>{labelize(authority.modifyAccount)}</strong></li>
        <li><span>Cancellation</span><strong>{labelize(authority.cancelService)}</strong></li>
        <li><span>Commitment ceiling</span><strong>{commitmentCeiling}</strong></li>
      </ul>}
      {alwaysAsk.length > 0 && <details><summary>Actions that always require review</summary><ul>{alwaysAsk.map((item) => <li key={item}>{item}</li>)}</ul></details>}
      {authority?.forbiddenActions && authority.forbiddenActions.length > 0 && <details><summary>Explicitly forbidden actions</summary><ul>{authority.forbiddenActions.map((item) => <li key={item}>{item}</li>)}</ul></details>}
      {caseItem?.brief && <section className="conditional-authority" aria-labelledby="conditional-authority-title">
        <div><h3 id="conditional-authority-title">Plan-specific conditions</h3><span>Plan {caseItem.brief.version}</span></div>
        <p>These rules are bound to this plan version and rechecked before a matching action can run.</p>
        {snapshot.conditionalAuthorityRules.length === 0 ? <p className="message-muted">No conditional authority was granted. Consequential actions still require the review level shown above.</p> : <ul>
          {snapshot.conditionalAuthorityRules.map((rule) => <li key={rule.id}>
            <div><strong>{labelize(rule.subject)}</strong><Badge tone={conditionalRuleTone(rule.decision)}>{labelize(rule.decision)}</Badge></div>
            <span>{conditionalRuleCondition(rule)}</span>
          </li>)}
        </ul>}
      </section>}
      {caseItem && <section className="secure-disclosures" aria-labelledby="secure-disclosures-title">
        <div><h3 id="secure-disclosures-title">Allowed sensitive details</h3><Badge tone="warn">Ask every time</Badge></div>
        <p>Plaintext stays only in this running server's memory. SQLite stores the label and delivery limits, never the value.</p>
        {caseItem.disclosures.length > 0 ? <ul>{caseItem.disclosures.map((item) => <li key={item.id}><span><strong>{item.label}</strong><small>{item.allowedChannels.map(labelize).join(" or ")}</small></span><Badge>{labelize(item.permission)}</Badge></li>)}</ul> : <p className="message-muted">No allowed sensitive details are available to the call.</p>}
        <button type="button" className="secure-disclosure-toggle" aria-expanded={disclosureOpen} onClick={() => setDisclosureOpen((value) => !value)}><LockKeyhole aria-hidden="true" /> {disclosureOpen ? "Close secure detail form" : "Add an allowed detail"}</button>
        {disclosureOpen && <form className="secure-disclosure-form" onSubmit={(event) => {
          event.preventDefault();
          const allowedChannels: SecureDisclosureInput["allowedChannels"] = [];
          if (speechAllowed) allowedChannels.push("SPEECH");
          if (dtmfAllowed) allowedChannels.push("DTMF");
          if (!disclosureValue.trim() || allowedChannels.length === 0) return;
          setAddingDisclosure(true);
          void onAddDisclosure(caseItem.id,{category:disclosureCategory,value:disclosureValue,allowedChannels}).then(() => {
            setDisclosureValue("");
            setDisclosureOpen(false);
          }).catch(() => undefined).finally(() => setAddingDisclosure(false));
        }}>
          <label htmlFor="secure-disclosure-category">Detail type<select id="secure-disclosure-category" value={disclosureCategory} onChange={(event) => {
            const next=event.target.value as SecureDisclosureInput["category"];
            setDisclosureCategory(next);
            if(next === "ADDRESS"){setSpeechAllowed(true);setDtmfAllowed(false);}
          }}><option value="ACCOUNT_NUMBER">Account number</option><option value="ORDER_NUMBER">Order number</option><option value="DATE_OF_BIRTH">Date of birth</option><option value="ADDRESS">Service or mailing address</option></select></label>
          <label htmlFor="secure-disclosure-value">Sensitive value<input id="secure-disclosure-value" type="password" autoComplete="off" spellCheck={false} maxLength={300} value={disclosureValue} onChange={(event) => setDisclosureValue(event.target.value)} /></label>
          <fieldset><legend>Allowed delivery channel</legend><label><input type="checkbox" checked={speechAllowed} onChange={(event) => setSpeechAllowed(event.target.checked)} /> Speech after your approval</label><label><input type="checkbox" checked={dtmfAllowed} disabled={disclosureCategory === "ADDRESS"} onChange={(event) => setDtmfAllowed(event.target.checked)} /> DTMF keypad after your approval</label></fieldset>
          {dtmfAllowed && <p className="secure-disclosure-hint">DTMF values may contain only digits, w, #, or *, up to 64 characters.</p>}
          <p className="secure-disclosure-warning"><AlertTriangle aria-hidden="true" /> Never enter a password, one-time code, full SSN, payment card, PIN, or security answer.</p>
          <div><button type="button" onClick={() => {setDisclosureOpen(false);setDisclosureValue("");}}>Cancel</button><button type="submit" className="primary" disabled={addingDisclosure || !disclosureValue.trim() || (!speechAllowed && !dtmfAllowed)}>{addingDisclosure ? "Saving securely…" : "Save allowed detail"}</button></div>
        </form>}
      </section>}
    </Panel>
  </>;
}

function SetupPanel({ configuration, failedDeliveries, deadLetterWork }: { configuration: ThreadSnapshot["configuration"]; failedDeliveries: number; deadLetterWork: number }) {
  const smsReady = configuration.messagingMode === "twilio_sms" && configuration.messagingConfigured && configuration.allowRealMessaging && configuration.ownerConfigured;
  return <Panel title="Messaging setup" icon={smsReady ? <Wifi aria-hidden="true" /> : <Settings2 aria-hidden="true" />}>
    <div className="setup-status"><Badge tone={smsReady ? "good" : "neutral"}>{smsReady ? "SMS enabled" : "Secure web enabled"}</Badge><Badge tone={configuration.messagingConfigured ? "good" : "warn"}>Provider {configuration.messagingConfigured ? "configured" : "not configured"}</Badge></div>
    <dl className="setup-facts">
      <div><dt>Active surface</dt><dd>{configuration.messagingMode === "twilio_sms" ? "Twilio SMS" : "Secure web"}</dd></div>
      <div><dt>Owner allowlist</dt><dd>{configuration.ownerConfigured ? "Configured" : "Not configured"}</dd></div>
      <div><dt>Real messaging</dt><dd>{configuration.allowRealMessaging ? "Enabled" : "Disabled"}</dd></div>
      <div><dt>Sender registration</dt><dd>{configuration.messagingRegistrationConfirmed ? "Operator confirmed" : "Not operator-confirmed"}</dd></div>
      <div><dt>Update detail</dt><dd>{labelize(configuration.messagingDetail)}</dd></div>
      <div><dt>Failed deliveries</dt><dd>{failedDeliveries}</dd></div>
      <div><dt>Dead-letter work</dt><dd>{deadLetterWork}</dd></div>
    </dl>
    <details className="webhook-details"><summary>Webhook endpoints</summary><dl>
      <div><dt>Inbound messages</dt><dd>{configuration.inboundMessagingWebhookUrl ? <code>{configuration.inboundMessagingWebhookUrl}</code> : "Not published"}</dd></div>
      <div><dt>Delivery status</dt><dd>{configuration.messagingStatusWebhookUrl ? <code>{configuration.messagingStatusWebhookUrl}</code> : "Not published"}</dd></div>
    </dl></details>
  </Panel>;
}

export function MessagingThread({ onOpenCase, onOpenCall, setGlobalError }: MessagingThreadProps) {
  const actionToken = useMemo(() => {
    const match = window.location.pathname.match(/^\/a\/([^/]+)\/?$/);
    return match ? decodeURIComponent(match[1]) : null;
  }, []);
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [localError, setLocalError] = useState("");
  const [announcement, setAnnouncement] = useState("Messaging thread ready.");
  const [actionDetail, setActionDetail] = useState<SecureActionDetail | null>(null);
  const [actionResolution, setActionResolution] = useState<"APPROVED" | "REJECTED" | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionLoading, setActionLoading] = useState(Boolean(actionToken));
  const scrollBox = useRef<HTMLDivElement>(null);
  const bottomMarker = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const announcedMessage = useRef("");

  const acceptSnapshot = useCallback((next: ThreadSnapshot) => {
    setSnapshot(next);
    setLocalError("");
  }, []);

  const loadThread = useCallback(async (signal?: AbortSignal, loud = false) => {
    try {
      const next = await api<ThreadSnapshot>("/api/messaging/thread", signal ? { signal } : {});
      acceptSnapshot(next);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      const text = cause instanceof Error ? cause.message : "Could not load the messaging thread";
      setLocalError(text);
      if (loud) setGlobalError(text);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [acceptSnapshot, setGlobalError]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadThread(controller.signal, true), 0);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [loadThread]);

  useEffect(() => {
    if (!actionToken) return;
    const controller = new AbortController();
    void api<SecureActionDetail>(`/api/actions/${encodeURIComponent(actionToken)}`, { signal: controller.signal }).then((result) => {
      if (result.tokenState !== "VALID" || !result.attention) throw new Error("This secure action link is invalid or no longer available.");
      setActionDetail(result);
    }).catch((cause) => {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setLocalError(cause instanceof Error ? cause.message : "Could not load the secure action");
    }).finally(() => {
      if (!controller.signal.aborted) setActionLoading(false);
    });
    return () => controller.abort();
  }, [actionToken]);

  const isActive = Boolean(
    snapshot?.attention?.status.toUpperCase() === "PENDING" ||
    (snapshot?.call && activeCallStates.has(snapshot.call.state.toUpperCase())) ||
    snapshot?.messages.some((message) => ["PENDING", "QUEUED", "PROCESSING"].includes(message.processingState.toUpperCase())),
  );

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      await loadThread(controller.signal);
      if (!controller.signal.aborted) timer = window.setTimeout(poll, isActive ? 1000 : 4000);
    };
    timer = window.setTimeout(poll, isActive ? 1000 : 4000);
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [isActive, loadThread]);

  useEffect(() => {
    if (!snapshot) return;
    const newest = [...snapshot.messages].reverse().find((message) => deliveryFailed(message) || messageIdentity(message) !== "USER");
    const key = newest ? `${newest.id}:${newest.deliveryState}:${newest.processingState}` : snapshot.attention?.id || "";
    if (snapshot.attention?.status.toUpperCase() === "PENDING") {
      const attentionKey = `attention:${snapshot.attention.id}`;
      if (announcedMessage.current !== attentionKey) {
        announcedMessage.current = attentionKey;
        setAnnouncement(`Decision needed: ${snapshot.attention.question}`);
      }
    } else if (newest && announcedMessage.current !== key) {
      announcedMessage.current = key;
      setAnnouncement(deliveryFailed(newest) ? "A message could not be delivered. Review the provider notice in the thread." : `Latest from ${messageLabel(newest)}: ${newest.redactedBody}`);
    }
  }, [snapshot]);

  useEffect(() => {
    if (!stickToBottom.current) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    bottomMarker.current?.scrollIntoView({ block: "end", behavior: reducedMotion ? "auto" : "smooth" });
  }, [snapshot?.messages.length]);

  const sendText = useCallback(async (text: string) => {
    const clean = text.trim();
    if (!clean || sending) return;
    setSending(true);
    setLocalError("");
    try {
      const next = await post<ThreadSnapshot>("/api/messaging/messages", { text: clean });
      acceptSnapshot(next);
      setDraft("");
      stickToBottom.current = true;
      setAnnouncement(`Sent: ${clean}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not send the message";
      setLocalError(message);
      setGlobalError(message);
    } finally {
      setSending(false);
    }
  }, [acceptSnapshot, sending, setGlobalError]);

  const submitMessage = (event: FormEvent) => {
    event.preventDefault();
    void sendText(draft);
  };

  const deleteCase = useCallback(async (caseId: string) => {
    setLocalError("");
    try {
      await api<void>(`/api/cases/${encodeURIComponent(caseId)}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmation: "DELETE", acknowledged: true }),
      });
      setDraft("");
      setActionDetail(null);
      setActionResolution(null);
      await loadThread(undefined, true);
      setAnnouncement("The case and its stored conversation data were deleted.");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not delete the case";
      setLocalError(message);
      setGlobalError(message);
      throw cause;
    }
  }, [loadThread, setGlobalError]);

  const addDisclosure = useCallback(async (caseId: string, input: SecureDisclosureInput) => {
    setLocalError("");
    try {
      const nextCase = await post<CaseDetail>(`/api/cases/${encodeURIComponent(caseId)}/disclosures`, input);
      setSnapshot((current) => current ? { ...current, case: nextCase } : current);
      setAnnouncement("The allowed sensitive detail was saved in volatile memory. Every use will require secure approval.");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not save the allowed sensitive detail";
      setLocalError(message);
      setGlobalError(message);
      throw cause;
    }
  }, [setGlobalError]);

  const submitAction = async (decision: "APPROVE" | "REJECT", confirmation: boolean, replacement?: string) => {
    if (!actionToken || !actionDetail) return;
    setActionBusy(true);
    setLocalError("");
    try {
      const body: { decision: "APPROVE" | "REJECT"; confirmation?: "CONFIRM"; replacement?: string } = { decision };
      if (confirmation) body.confirmation = "CONFIRM";
      if (replacement) body.replacement = replacement;
      const nextSnapshot = await post<ThreadSnapshot>(`/api/actions/${encodeURIComponent(actionToken)}`, body);
      acceptSnapshot(nextSnapshot);
      setActionDetail((current) => current ? { ...current, attention: { ...current.attention, status: "RESOLVED" } } : current);
      setActionResolution(decision === "APPROVE" ? "APPROVED" : "REJECTED");
      setAnnouncement(`Secure request ${decision === "APPROVE" ? "approved" : "rejected"}.`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not submit the secure decision";
      setLocalError(message);
      setGlobalError(message);
    } finally {
      setActionBusy(false);
    }
  };

  if (loading && !snapshot) return <section className="messaging-loading" aria-busy="true"><MessageSquareText aria-hidden="true" /><h1>Opening your Liaison thread</h1><p>Loading recent messages and case state…</p></section>;

  if (!snapshot) return <section className="messaging-unavailable"><WifiOff aria-hidden="true" /><h1>Messaging is unavailable</h1><p>{localError || "The thread could not be loaded."}</p><button type="button" onClick={() => void loadThread(undefined, true)}><RotateCcw aria-hidden="true" /> Try again</button></section>;

  return <div className="liaison-messaging">
    <div className="message-live-update" role="status" aria-live="polite" aria-atomic="true"><span>Latest important update</span><p>{announcement}</p></div>
    {localError && <div className="message-inline-error" role="alert"><AlertTriangle aria-hidden="true" /><span>{localError}</span><button type="button" onClick={() => setLocalError("")} aria-label="Dismiss messaging error">×</button></div>}
    {actionToken && (actionLoading ? <section className="secure-review secure-review-loading" aria-busy="true"><LockKeyhole aria-hidden="true" /><p>Loading secure decision…</p></section> : actionDetail ? <SecureActionReview detail={actionDetail} resolution={actionResolution} busy={actionBusy} onDecision={(decision, confirmation, replacement) => void submitAction(decision, confirmation, replacement)} /> : <section className="secure-review secure-review-invalid" role="alert"><AlertTriangle aria-hidden="true" /><div><h1>Secure decision unavailable</h1><p>The link is invalid, expired, already used, or no longer bound to a pending decision. No action was taken.</p></div></section>)}
    <header className="message-page-title">
      <div><p className="message-kicker">Private support workspace</p><h1>Your Liaison thread</h1><p>Describe the issue naturally, review the plan, then authorize one call with the short-lived code Liaison provides.</p></div>
      <div className="thread-status" aria-label="Thread status"><Badge tone={isActive ? "good" : "neutral"}>{labelize(snapshot.thread.state)}</Badge><span>{snapshot.thread.messagingOptState === "OPTED_OUT" ? "Messaging opted out" : "Messages available"}</span></div>
    </header>
    <div className="messaging-layout">
      <main className="thread-card" aria-labelledby="conversation-title">
        <header className="thread-card-header"><div><p className="message-kicker">Conversation</p><h2 id="conversation-title">Messages</h2></div><span>{snapshot.messages.length} {snapshot.messages.length === 1 ? "message" : "messages"}</span></header>
        {snapshot.attention?.status.toUpperCase() === "PENDING" && <div className="thread-attention"><AttentionCard attention={snapshot.attention} secureActionHref={[...snapshot.messages].reverse().filter((message) => message.attentionRequestId === snapshot.attention?.id).map((message) => findSameOriginActionHref(message.redactedBody, window.location.origin)).find((href): href is string => Boolean(href)) ?? null} busy={sending} onChoose={(code) => void sendText(code)} /></div>}
        <div className="message-scroll" ref={scrollBox} onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
        }}>
          {snapshot.messages.length === 0 ? <div className="thread-empty"><MessageSquareText aria-hidden="true" /><h3>Start with the support problem</h3><p>For example: “My internet bill increased after a promotion ended. I want to understand the charge and restore my prior price.”</p></div> : <ol className="message-list" aria-label="Message history">{snapshot.messages.map((message) => <MessageItem key={message.id} message={message} />)}</ol>}
          <div ref={bottomMarker} />
        </div>
        <div className="quick-commands" aria-label="Quick commands"><span>Quick commands</span>{["STATUS", "PAUSE", "RESUME", "HANGUP"].map((command) => <button type="button" key={command} disabled={sending} onClick={() => void sendText(command)}>{command}</button>)}</div>
        <form className="message-composer" onSubmit={submitMessage}>
          <label htmlFor="message-draft">Message Liaison</label>
          <div><textarea id="message-draft" rows={2} maxLength={1600} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }} placeholder="Describe the issue, reply A/B/C, or enter CALL followed by your code" /><button className="primary" disabled={sending || !draft.trim()}>{sending ? "Sending…" : <><Send aria-hidden="true" /> Send</>}</button></div>
          <p><span>{draft.length}/1600</span><span>Ctrl + Enter sends · Never send passwords or one-time login codes.</span></p>
        </form>
      </main>
      <aside className="message-sidebar" aria-label="Case and messaging details">
        <CasePanel snapshot={snapshot} onOpenCase={onOpenCase} onOpenCall={onOpenCall} onMode={(mode) => void sendText(`MODE ${mode}`)} onDeleteCase={deleteCase} onAddDisclosure={addDisclosure} />
        <CommitmentsPanel commitments={snapshot.commitments} />
        <SetupPanel configuration={snapshot.configuration} failedDeliveries={snapshot.failedDeliveries} deadLetterWork={snapshot.deadLetterWork} />
        <Panel title="Command guide" icon={<UserRound aria-hidden="true" />}><dl className="command-guide"><div><dt>STATUS</dt><dd>Current case and call state</dd></div><div><dt>CALL &lt;code&gt;</dt><dd>Use one short-lived call authorization</dd></div><div><dt>PAUSE / RESUME</dt><dd>Control Liaison during a call</dd></div><div><dt>HANGUP</dt><dd>End the active call</dd></div><div><dt>STOP</dt><dd>Opt out of SMS messaging</dd></div></dl></Panel>
        <p className="provider-note"><CircleDollarSign aria-hidden="true" /> Cost figures are estimates, not invoices. Carrier messaging and Twilio usage charges may apply when real providers are enabled.</p>
      </aside>
    </div>
  </div>;
}
