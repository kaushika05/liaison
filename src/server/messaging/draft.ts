import {z} from "zod";
import {normalizeUsPhone} from "../core/policy.js";

export const draftFieldSchema=z.enum(["USER_FIRST_NAME","COMPANY_NAME","PHONE_NUMBER","DESIRED_OUTCOME","ACCOUNT_AUTHORITY"]);
export type DraftField=z.infer<typeof draftFieldSchema>;
export const planCheckpointSchema=z.object({
  sourceMessageId:z.string().min(1).max(200),
  caseId:z.string().min(1).max(100),
  operation:z.enum(["CREATE","REVISE"]),
  basePlanVersion:z.number().int().min(0),
  committedPlanVersion:z.number().int().positive().optional(),
}).strict();
export type PlanCheckpoint=z.infer<typeof planCheckpointSchema>;
export const supportDraftSchema=z.object({
  userFirstName:z.string().trim().min(1).max(80).optional(),
  companyName:z.string().trim().min(1).max(120).optional(),
  phoneNumberE164:z.string().regex(/^\+1\d{10}$/).optional(),
  issueDescription:z.string().trim().min(1).max(6_000).optional(),
  desiredOutcome:z.string().trim().min(3).max(2_000).optional(),
  acceptableAlternatives:z.array(z.string().trim().min(1).max(500)).max(15).default([]),
  unacceptableOutcomes:z.array(z.string().trim().min(1).max(500)).max(15).default([]),
  knownFacts:z.array(z.string().trim().min(1).max(1_000)).max(40).default([]),
  awaitingField:draftFieldSchema.optional(),
  authorizedAccountConfirmed:z.boolean().default(false),
  sourceMessages:z.number().int().min(0).default(0),
  pendingPlanSourceMessageId:z.string().min(1).max(200).optional(),
  planCheckpoint:planCheckpointSchema.optional(),
});
export type SupportDraft=z.infer<typeof supportDraftSchema>;

function sentence(text:string,pattern:RegExp):string|undefined{return text.split(/(?<=[.!?])\s+|\n+/).map((item)=>item.trim()).find((item)=>pattern.test(item));}
function cleanCompany(value:string):string{return value.replace(/\s+(?:customer\s+)?support$/i,"").replace(/[.,;:]+$/,"").trim();}
function extractPhone(text:string):string|undefined{const match=text.match(/(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}/);if(!match)return;try{return normalizeUsPhone(match[0]);}catch{return;}}

export function collectSupportDraft(current:unknown,message:string,ownerDisplayName=""):SupportDraft {
  const prior=supportDraftSchema.parse(current??{});const text=message.trim();const next:SupportDraft={...prior,sourceMessages:prior.sourceMessages+1};
  if(prior.awaitingField==="USER_FIRST_NAME"&&text.length<=80)next.userFirstName=text.split(/\s+/)[0];
  else if(prior.awaitingField==="COMPANY_NAME"&&text.length<=120)next.companyName=cleanCompany(text);
  else if(prior.awaitingField==="PHONE_NUMBER")next.phoneNumberE164=extractPhone(text);
  else if(prior.awaitingField==="DESIRED_OUTCOME"&&text.length<=2_000)next.desiredOutcome=text;
  else if(prior.awaitingField==="ACCOUNT_AUTHORITY"&&/^(?:yes|i confirm|confirmed|this is my account|i am authorized)[.!]?$/i.test(text))next.authorizedAccountConfirmed=true;

  next.userFirstName??=ownerDisplayName.trim().split(/\s+/)[0]||undefined;
  const phone=extractPhone(text);if(phone)next.phoneNumberE164=phone;
  const companyLabel=/\bcompany\s*:\s*([^\n]{1,120})/i.exec(text)?.[1];
  const callCompany=/\bcall\s+(.{1,120}?)\s+(?:at|on)\s+(?=(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3}))/i.exec(text)?.[1];
  if(companyLabel||callCompany)next.companyName=cleanCompany((companyLabel??callCompany)!);
  const desired=sentence(text,/\b(?:i want|i need (?:them|the company|support) to|my goal is|desired (?:outcome|resolution)|i would like)\b/i);
  if(desired)next.desiredOutcome=desired.replace(/^.*?\b(?:i want|i need (?:them|the company|support) to|my goal is|desired (?:outcome|resolution)(?: is)?|i would like)\b\s*/i,"").replace(/[.!]+$/,"").trim();
  const unacceptable=text.split(/(?<=[.!?])\s+|\n+/).filter((item)=>/^\s*(?:do not|don't|never|must not|i will not)/i.test(item)).map((item)=>item.trim().replace(/[.!]+$/,""));
  next.unacceptableOutcomes=[...new Set([...next.unacceptableOutcomes,...unacceptable])].slice(0,15);
  const alternative=sentence(text,/\b(?:is (?:okay|acceptable) only if|acceptable alternative|i can accept)\b/i);if(alternative&&!next.acceptableAlternatives.includes(alternative))next.acceptableAlternatives=[...next.acceptableAlternatives,alternative].slice(0,15);
  if(!next.issueDescription||prior.awaitingField===undefined)next.issueDescription=[next.issueDescription,text].filter(Boolean).join("\n").slice(0,6_000);
  // Ordinary first-person wording is not proof of authority. The owner must
  // answer the explicit ACCOUNT_AUTHORITY question before a plan is executable.
  if(/\b(?:friend|client|customer|neighbor|coworker|mother|father|parent|spouse|partner|child|son|daughter|sibling|brother|sister|someone else)(?:'s|\s+account)\b/i.test(text))next.authorizedAccountConfirmed=false;
  next.awaitingField=nextMissingDraftField(next);
  return supportDraftSchema.parse(next);
}

export function nextMissingDraftField(draft:SupportDraft):DraftField|undefined {
  if(!draft.userFirstName)return"USER_FIRST_NAME";if(!draft.companyName)return"COMPANY_NAME";if(!draft.phoneNumberE164)return"PHONE_NUMBER";if(!draft.desiredOutcome)return"DESIRED_OUTCOME";if(!draft.authorizedAccountConfirmed)return"ACCOUNT_AUTHORITY";return undefined;
}

export function clarificationFor(field:DraftField):string {const copy:Record<DraftField,string>={USER_FIRST_NAME:"What first name should the assistant use when it introduces itself?",COMPANY_NAME:"Which company should Liaison contact?",PHONE_NUMBER:"What is the official US support number? Liaison checks the format but cannot verify who owns the number.",DESIRED_OUTCOME:"What exact outcome do you want from this support call?",ACCOUNT_AUTHORITY:"Is this your account, or one you are authorized to manage? Reply YES to confirm."};return copy[field];}
