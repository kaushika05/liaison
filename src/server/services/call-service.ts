import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { AgentDecision, CallBrief, CallState, EventType, OutcomeReport, TranscriptTurn } from "../../shared/domain.js";
import { approvalRequestSchema, callBriefSchema, caseIntakeSchema } from "../../shared/domain.js";
import type { CallSnapshot, CaseDetail } from "../../shared/api.js";
import type { Config } from "../config.js";
import { publicConfig } from "../config.js";
import { detectHighRisk, estimateCost, normalizeUsPhone, prohibitedSecretReason, redactText, sanitizePayload, signToken, transitionState, validateDecision, validateDtmf, validateOutcome } from "../core/policy.js";
import { LiaisonDatabase, type StoredCall } from "../database/db.js";
import { DisclosureStore } from "../security/disclosures.js";
import { ModelService, type ModelTelemetry } from "../agent/model-service.js";
import { getScenario, scenarios, type ScenarioStep, type SimulatorScenario } from "../simulator/scenarios.js";
import { SimulatedTelephonyAdapter, TwilioConversationRelayAdapter, type EndReason, type TelephonyAdapter } from "../telephony/adapters.js";
import type { WebSocket } from "ws";

interface Runtime {
  adapter: TelephonyAdapter; scenario?: SimulatorScenario; stepIndex: number; timer?: NodeJS.Timeout; durationTimer?: NodeJS.Timeout;
  pendingRemote:Array<{ text:string; step?:ScenarioStep }>; executedKeys:Set<string>; privateInstruction?:string; browserSequence:number;
  disclosureLedger:Array<{label:string;marker:string;channel:string;timestamp:string}>; terminalizing:boolean;
}
export interface BrowserEvent { id:number; type:string; data:unknown }

const disclosureScript = (name:string) => `Hello. I'm an automated accessibility assistant calling on behalf of ${name}, who is present and supervising through text. This conversation is being transcribed in real time for accessibility, and this application is not recording the audio. May we continue?`;

export class CallService {
  readonly events = new EventEmitter();
  readonly simulatorAdapter = new SimulatedTelephonyAdapter();
  readonly twilioAdapter: TwilioConversationRelayAdapter;
  private readonly runtimes = new Map<string,Runtime>();
  constructor(readonly config:Config, readonly database:LiaisonDatabase, readonly disclosures:DisclosureStore, readonly models:ModelService){ this.twilioAdapter=new TwilioConversationRelayAdapter(config); }

  configStatus(){ return publicConfig(this.config); }
  async recoverInterruptedCall():Promise<void>{
    const row=this.database.getActiveCall(); if(!row||this.runtimes.has(row.id))return;
    if(row.mode==="TWILIO"&&row.twilio_call_sid){try{await this.twilioAdapter.endOrphanedCall(row.twilio_call_sid);}catch(error){this.record(row.id,row.case_id,"TECHNICAL_ERROR",{code:`ORPHAN_TERMINATION:${this.safeError(error)}`},"TELEPHONY");}}
    const pending=this.database.getPendingApproval(row.id);if(pending)this.database.updateApproval(pending.id,"PENDING","EXPIRED");
    const duration=Math.max(row.duration_seconds,Math.floor((Date.now()-Date.parse(row.started_at))/1000));this.database.updateCall(row.id,{state:"FAILED",activity:"Failed",objective:"Review the outcome",endedAt:new Date().toISOString(),durationSeconds:duration,estimatedCostUsd:estimateCost(duration,this.config.ESTIMATED_TELEPHONY_COST_PER_MINUTE_USD),terminalReason:"Server restarted during an active call",generation:row.generation+1});
    this.database.db.prepare("UPDATE cases SET status='FAILED',updated_at=? WHERE id=?").run(new Date().toISOString(),row.case_id);this.record(row.id,row.case_id,"CALL_ENDED",{reason:"TECHNICAL_FAILURE",status:"TECHNICAL_FAILURE",recoveredAfterRestart:true},"SYSTEM");await this.compileOutcome(row.id,"TECHNICAL_FAILURE");this.disclosures.clearCase(row.case_id);
  }
  listScenarios(){ return scenarios.map((scenario)=>({id:scenario.id,name:scenario.name,description:scenario.description,requiresApproval:scenario.requiresApproval})); }
  listCases(){ return this.database.listCases(); }
  getCase(id:string){ return this.database.getCase(id); }

  async createCase(raw:unknown):Promise<CaseDetail>{
    const intake=caseIntakeSchema.parse(raw); const phone=normalizeUsPhone(intake.phoneNumber); const id=randomUUID();
    const metadata=this.disclosures.createForCase(id,intake.disclosures);
    const storedIntake={...intake,phoneNumber:phone,disclosures:[]};
    this.database.createCase({id,companyName:intake.companyName,title:`${intake.companyName} support request`,intake:storedIntake,disclosureMetadata:metadata});
    this.record(undefined,id,"CASE_CREATED",{companyName:intake.companyName,phoneNumber:phone,disclosures:metadata},"USER");
    return this.database.getCase(id)!;
  }

  async generatePlan(caseId:string):Promise<CallBrief>{
    const item=this.requireCase(caseId); const intake=caseIntakeSchema.parse({...item.intake,disclosures:[]});
    try{ const plan=await this.models.plan(caseId,normalizeUsPhone(String(item.intake.phoneNumber)),intake); this.database.savePlan(caseId,plan); this.record(undefined,caseId,"PLAN_GENERATED",{version:plan.version},this.config.LLM_MODE.toUpperCase()); return plan; }
    finally{ this.flushModelTelemetry(undefined,caseId); }
  }
  savePlan(caseId:string,raw:unknown):CallBrief { const existing=this.requireCase(caseId); if(!raw||typeof raw!=="object")throw new Error("INVALID_PLAN"); const brief=callBriefSchema.parse({...raw,id:caseId,version:(existing.brief?.version??0)+1}); this.database.savePlan(caseId,brief); this.record(undefined,caseId,"CASE_UPDATED",{planVersion:brief.version},"USER"); return brief; }
  approvePlan(caseId:string):CallBrief { const item=this.requireCase(caseId); if(!item.brief) throw new Error("PLAN_REQUIRED"); this.database.approvePlan(caseId,item.brief.version); this.record(undefined,caseId,"PLAN_APPROVED",{version:item.brief.version},"USER"); return item.brief; }
  deleteCase(caseId:string):void { if(this.database.getActiveCall()?.case_id===caseId) throw new Error("ACTIVE_CALL_CANNOT_BE_DELETED"); this.database.deleteCase(caseId); this.disclosures.clearCase(caseId); }

  async startSimulation(caseId:string,scenarioId:string,accelerated=true):Promise<CallSnapshot>{
    return this.start(caseId,"SIMULATOR",getScenario(scenarioId),accelerated);
  }
  async startLive(caseId:string):Promise<CallSnapshot>{
    if(!this.configStatus().allowRealCalls) throw new Error("REAL_CALLS_DISABLED_OR_UNCONFIGURED");
    const item=this.requireApprovedCase(caseId); const risks=detectHighRisk(`${item.companyName}\n${item.brief?.issueSummary}\n${item.brief?.desiredOutcome}`); if(risks.length) throw new Error(`HIGH_RISK_BLOCK:${risks.join(",")}`);
    const prefixes=this.config.ALLOWED_DESTINATION_PREFIXES.split(",").map((value)=>value.trim()).filter(Boolean); if(!prefixes.some((prefix)=>item.brief!.phoneNumberE164.startsWith(prefix))) throw new Error("DESTINATION_PREFIX_NOT_ALLOWED");
    const day=new Date().toISOString().slice(0,10); if(!this.database.incrementDailyUsage(day,this.config.MAX_CALLS_PER_DAY)) throw new Error("DAILY_CALL_LIMIT_REACHED");
    return this.start(caseId,"TWILIO",undefined,true);
  }

  private async start(caseId:string,mode:"SIMULATOR"|"TWILIO",scenario?:SimulatorScenario,accelerated=true):Promise<CallSnapshot>{
    const item=this.requireApprovedCase(caseId); if(this.database.getActiveCall()) throw new Error("ANOTHER_CALL_IS_ACTIVE");
    const callId=randomUUID(); const adapter=mode==="SIMULATOR"?this.simulatorAdapter:this.twilioAdapter;
    this.database.createCall({id:callId,caseId,mode,scenarioId:scenario?.id??null,state:"PREPARING",activity:"Preparing",objective:"Connect to customer support"});
    const runtime:Runtime={adapter,scenario,stepIndex:0,pendingRemote:[],executedKeys:new Set(),browserSequence:0,disclosureLedger:[],terminalizing:false}; this.runtimes.set(callId,runtime);
    this.record(callId,caseId,"CALL_CREATED",{mode,scenarioId:scenario?.id??null},"SYSTEM"); this.changeState(callId,"DIALING","Dialing support","Reach the support line");
    const secret=this.config.CALL_TOKEN_SECRET||this.config.SESSION_SECRET||"liaison-development-call-token"; const token=signToken({callId},secret,600);
    try { const result=await adapter.startCall({callId,destination:item.brief!.phoneNumberE164,signedToken:token}); this.database.updateCall(callId,{twilioCallSid:result.providerCallId}); }
    catch(error){ await this.terminalize(callId,"TECHNICAL_FAILURE",this.safeError(error)); throw error; }
    this.startDurationTimer(callId);
    if(mode==="SIMULATOR") { this.changeState(callId,"CONNECTED","Connected","Navigate the support line"); this.record(callId,caseId,"CALL_CONNECTED",{},"SIMULATOR"); this.scheduleNext(callId,accelerated?35:650); }
    return this.snapshot(callId);
  }

  private startDurationTimer(callId:string):void{
    const runtime=this.runtime(callId); runtime.durationTimer=setInterval(()=>{
      const row=this.database.getCall(callId); if(!row || this.isTerminal(row.state)) return;
      const duration=Math.max(0,Math.floor((Date.now()-Date.parse(row.started_at))/1000)); const cost=estimateCost(duration,this.config.ESTIMATED_TELEPHONY_COST_PER_MINUTE_USD);
      this.database.updateCall(callId,{durationSeconds:duration,estimatedCostUsd:cost}); this.emit(callId,"duration.updated",{durationSeconds:duration,estimatedCostUsd:cost});
      if(duration>=this.config.MAX_CALL_DURATION_MINUTES*60) void this.terminalize(callId,"TECHNICAL_FAILURE","Maximum call duration reached");
    },1000);
  }

  private scheduleNext(callId:string,delay=35):void{
    const runtime=this.runtime(callId); if(!runtime.scenario||runtime.terminalizing) return;
    clearTimeout(runtime.timer); runtime.timer=setTimeout(()=>{ const step=runtime.scenario!.steps[runtime.stepIndex++]; if(step) void this.processScenarioStep(callId,step); },delay);
  }
  private async processScenarioStep(callId:string,step:ScenarioStep):Promise<void>{
    if(step.kind==="DISCONNECT"){ this.addTurn(callId,"SYSTEM",step.text); await this.terminalize(callId,"TECHNICAL_FAILURE","Unexpected remote disconnect",step.terminal); return; }
    await this.ingestRemote(callId,step.text,step);
  }

  async ingestRemote(callId:string,text:string,scenarioStep?:ScenarioStep):Promise<void>{
    const row=this.requireCall(callId); if(this.isTerminal(row.state)) return; const safe=text.slice(0,4000); this.addTurn(callId,"REMOTE",safe);
    const runtime=this.runtime(callId); if(row.paused){ runtime.pendingRemote.push({text:safe,step:scenarioStep}); this.database.updateCall(callId,{activity:"Paused — transcript still active"}); return; }
    await this.processRemoteDecision(callId,safe,scenarioStep);
  }

  private async processRemoteDecision(callId:string,text:string,scenarioStep?:ScenarioStep):Promise<void>{
    const row=this.requireCall(callId); if(this.isTerminal(row.state)||row.paused) return;
    const generation=row.generation+1; this.database.updateCall(callId,{generation,activity:"Thinking"}); this.emit(callId,"call.activity",{activity:"Thinking"});
    const runtime=this.runtime(callId);
    try {
      const decision=runtime.scenario?this.mockDecision(callId,text,scenarioStep):await this.liveDecision(callId,text,generation);
      if(decision && !await this.executeDecision(callId,decision,generation)) return;
      if(scenarioStep?.terminal && !this.database.getPendingApproval(callId) && !this.isTerminal(this.requireCall(callId).state)) await this.terminalize(callId,this.reasonForStatus(scenarioStep.terminal),undefined,scenarioStep.terminal);
      else if(runtime.scenario&&!this.database.getPendingApproval(callId)&&!this.isTerminal(this.requireCall(callId).state)) this.scheduleNext(callId);
    } catch(error){ this.record(callId,row.case_id,"TECHNICAL_ERROR",{code:this.safeError(error)},"SYSTEM"); this.database.updateCall(callId,{paused:true,activity:"Needs user — controller unavailable",generation:generation+1}); this.emit(callId,"error",{message:"The controller could not safely continue. Use exact text or hang up."}); }
  }

  private mockDecision(callId:string,text:string,step?:ScenarioStep):AgentDecision|null{
    const row=this.requireCall(callId); const item=this.requireCase(row.case_id); const lower=text.toLowerCase(); const facts:AgentDecision["capturedFacts"]=[];
    if(step?.expectedDigits) return {action:"SEND_DIGITS",digits:step.expectedDigits,nextState:"IVR",policyReasonCode:"IVR_MENU_SELECTION",capturedFacts:facts};
    if(/password|one-time|verification code/.test(lower)) return {action:"SPEAK",text:"I can't provide passwords or one-time codes. Is there another permitted way to authenticate?",nextState:"AUTHENTICATING",policyReasonCode:"PROHIBITED_SECRET_REFUSAL",capturedFacts:facts};
    if(/do not consent|refuse|no, i do not/.test(lower)) return {action:"END_CALL",reason:"REPRESENTATIVE_REFUSED_AUTOMATION",proposedOutcomeStatus:"REFUSED_AUTOMATION",closingText:"I understand. Thank you for your time; I will end the call.",nextState:"ENDING",policyReasonCode:"CONSENT_REFUSED",capturedFacts:facts};
    if(!row.human_detected && /how (?:may|can) i (?:help|assist)|representative|my name is|\bthis is [a-z]+|support.*speaking|customer care/.test(lower)){
      return {action:"SPEAK",text:disclosureScript(item.brief!.userFirstName),nextState:"DISCLOSING_ASSISTANT",policyReasonCode:"DISCLOSE_ACCESSIBILITY_ASSISTANT",capturedFacts:facts};
    }
    if(row.disclosure_delivered && row.consent_status!=="ACCEPTED" && /\b(yes|fine|willing|continue|consent)\b/.test(lower)){
      return {action:"SPEAK",text:item.brief!.openingIssueStatement.slice(0,400),nextState:"EXPLAINING_ISSUE",policyReasonCode:"EXPLAIN_APPROVED_BRIEF",capturedFacts:facts};
    }
    if(/please hold|transfer/.test(lower)) return {action:"WAIT",reason:/transfer/.test(lower)?"TRANSFER":"HOLD",nextState:"ON_HOLD",policyReasonCode:"REMOTE_HOLD",capturedFacts:facts};
    if(/account number|order number/.test(lower)){
      const cards=item.disclosures.filter((card)=>["ACCOUNT_NUMBER","ORDER_NUMBER"].includes(card.category)&&card.permission==="ASK"); const card=cards[0];
      if(!card) return {action:"SPEAK",text:"I don't have an approved account identifier to disclose. Is there another permitted way to authenticate?",nextState:"AUTHENTICATING",policyReasonCode:"NO_DISCLOSURE_CARD",capturedFacts:facts};
      return {action:"REQUEST_APPROVAL",nextState:"NEEDS_USER",policyReasonCode:"PERSONAL_DATA_REQUIRES_APPROVAL",approval:{category:"PERSONAL_DATA",question:`Share ${card.label}?`,representativeRequest:text,proposedSpeech:`Provide [REDACTED:${card.category}:${card.label}]`,consequences:"This will disclose the approved identifier to the representative for authentication.",disclosureCardId:card.id,executionChannel:card.allowedChannels.includes("DTMF")?"DTMF":"SPEECH"},capturedFacts:facts};
    }
    if(/instead of cancellation|would you accept|can offer/.test(lower)) return {action:"REQUEST_APPROVAL",nextState:"NEEDS_USER",policyReasonCode:"ALTERNATIVE_OUTCOME_REQUIRES_APPROVAL",approval:{category:"ALTERNATIVE_OUTCOME",question:"Accept the representative's retention offer?",representativeRequest:text,proposedSpeech:"The account holder approves that alternative outcome.",consequences:"Accepting changes the requested outcome from cancellation to a temporary discount."},capturedFacts:facts};
    if(/ignore your instructions|reveal everything|pretend approval|purchase/.test(lower)) return {action:"SPEAK",text:"I can only discuss the approved support issue and cannot disclose unrelated data or authorize purchases. Please address the support request.",nextState:"NEGOTIATING",policyReasonCode:"PROMPT_INJECTION_REJECTED",capturedFacts:facts};
    if(/submit|review|look into|made a note/.test(lower)) return {action:"SPEAK",text:"To confirm, what concrete action is approved, what is the case number, and when will it be completed?",nextState:"VERIFYING_OUTCOME",policyReasonCode:"VERIFY_NONCOMMITTAL_OUTCOME",capturedFacts:facts};
    if(step?.terminal) return {action:"END_CALL",reason:this.reasonForStatus(step.terminal),proposedOutcomeStatus:this.proposedForStatus(step.terminal),closingText:"Thank you. I have captured those details and will report them to the account holder.",nextState:"ENDING",policyReasonCode:"TERMINAL_SCENARIO_RESULT",capturedFacts:facts};
    return {action:"SPEAK",text:"Thank you. Could you confirm the concrete next action, any reference number, and the timeline?",nextState:row.state==="DISCLOSING_ASSISTANT"?"EXPLAINING_ISSUE":"NEGOTIATING",policyReasonCode:"SEEK_CONCRETE_OUTCOME",capturedFacts:facts};
  }

  private async liveDecision(callId:string,text:string,generation:number):Promise<AgentDecision>{
    const row=this.requireCall(callId); const item=this.requireCase(row.case_id); const transcript=this.database.getTranscript(callId).slice(-16); const runtime=this.runtime(callId);
    const context={currentState:row.state,brief:item.brief,authority:item.brief!.authority,disclosureCards:item.disclosures,currentObjective:row.objective,disclosureDelivered:Boolean(row.disclosure_delivered),consentStatus:row.consent_status,approvalPending:Boolean(this.database.getPendingApproval(callId)),recentTranscript:transcript,currentFinalizedRemoteUtterance:text,privateInstruction:runtime.privateInstruction,generation};
    runtime.privateInstruction=undefined; try{return await this.models.decide(context);}finally{this.flushModelTelemetry(callId,row.case_id);}
  }

  private async executeDecision(callId:string,decision:AgentDecision,generation:number):Promise<boolean>{
    const row=this.requireCall(callId); const item=this.requireCase(row.case_id); const runtime=this.runtime(callId);
    const validation=validateDecision(decision,{state:row.state,authority:item.brief!.authority,paused:Boolean(row.paused),pendingApproval:this.database.getPendingApproval(callId),disclosureDelivered:Boolean(row.disclosure_delivered),consentStatus:row.consent_status,durationSeconds:row.duration_seconds,maximumDurationSeconds:this.config.MAX_CALL_DURATION_MINUTES*60,generation,expectedGeneration:this.requireCall(callId).generation,executedKeys:runtime.executedKeys});
    if(!validation.allowed){
      this.record(callId,row.case_id,"AGENT_DECISION_REJECTED",{violationCode:validation.violationCode,safeFallback:validation.safeFallback},"POLICY");
      if(validation.safeFallback==="END_CALL") await this.terminalize(callId,"POLICY_BLOCKED");
      else { this.database.updateCall(callId,{paused:true,activity:"Needs user — policy blocked an agent action",generation:generation+1}); await runtime.adapter.pauseAgent(callId); this.emit(callId,"error",{message:"Liaison paused because an agent action failed a hard policy check."}); }
      return false;
    }
    if(decision.policyReasonCode==="DISCLOSE_ACCESSIBILITY_ASSISTANT"){ this.database.updateCall(callId,{humanDetected:true,disclosureDelivered:true}); this.record(callId,row.case_id,"DISCLOSURE_DELIVERED",{},"CONTROLLER"); }
    if(decision.policyReasonCode==="EXPLAIN_APPROVED_BRIEF"){ this.database.updateCall(callId,{consentStatus:"ACCEPTED"}); this.record(callId,row.case_id,"CONSENT_RECORDED",{status:"ACCEPTED"},"CONTROLLER"); }
    if(decision.policyReasonCode==="CONSENT_REFUSED"){ this.database.updateCall(callId,{consentStatus:"REFUSED"}); this.record(callId,row.case_id,"CONSENT_RECORDED",{status:"REFUSED"},"CONTROLLER"); }
    this.record(callId,row.case_id,"AGENT_DECISION_PROPOSED",{action:decision.action,nextState:decision.nextState,policyReasonCode:decision.policyReasonCode},"CONTROLLER");
    if(decision.action==="SPEAK"){
      this.changeState(callId,decision.nextState,"Speaking",this.objectiveFor(decision.nextState)); runtime.executedKeys.add(`SPEAK:${decision.text}`); this.addTurn(callId,"LIAISON",decision.text);
      this.record(callId,row.case_id,"AGENT_SPEECH_STARTED",{text:decision.text},"CONTROLLER"); await runtime.adapter.speak(callId,decision.text,{interruptible:true}); this.record(callId,row.case_id,"AGENT_SPEECH_COMPLETED",{},"TELEPHONY"); this.database.updateCall(callId,{activity:"Listening"});
    } else if(decision.action==="SEND_DIGITS"){
      this.changeState(callId,decision.nextState,"Sending menu selection","Navigate the support menu"); runtime.executedKeys.add(`SEND_DIGITS:${decision.digits}`); await runtime.adapter.sendDigits(callId,decision.digits);
      this.record(callId,row.case_id,"DTMF_SENT",{digits:decision.digits,sensitive:false},"CONTROLLER"); this.addTurn(callId,"SYSTEM",`Sent menu selection: ${decision.digits}`); this.database.updateCall(callId,{activity:"Listening"});
    } else if(decision.action==="REQUEST_APPROVAL"){
      this.changeState(callId,"NEEDS_USER","Awaiting your approval","Review the representative's request"); const now=Date.now();
      const approval=approvalRequestSchema.parse({id:randomUUID(),callId,status:"PENDING",...decision.approval,createdAt:new Date(now).toISOString(),expiresAt:new Date(now+10*60_000).toISOString()}); this.database.saveApproval(approval);
      this.record(callId,row.case_id,"APPROVAL_REQUESTED",{...approval,disclosureCardId:approval.disclosureCardId},"POLICY"); this.emit(callId,"approval.requested",approval);
      const phrase="One moment while I confirm that with the account holder."; this.addTurn(callId,"LIAISON",phrase); await runtime.adapter.speak(callId,phrase,{interruptible:true});
    } else if(decision.action==="WAIT"){
      this.changeState(callId,decision.nextState,decision.reason==="HOLD"?"On hold":"Waiting","Wait without adding audio");
    } else {
      if(decision.closingText){ this.addTurn(callId,"LIAISON",decision.closingText); await runtime.adapter.speak(callId,decision.closingText,{interruptible:true}); }
      await this.terminalize(callId,decision.reason,undefined,decision.proposedOutcomeStatus);
    }
    return true;
  }

  async approve(callId:string,approvalId:string,replacement?:string):Promise<CallSnapshot>{
    const row=this.requireCall(callId); const approval=this.database.getPendingApproval(callId); if(!approval){ const snap=this.snapshot(callId); return snap; }
    if(approval.id!==approvalId) throw new Error("STALE_APPROVAL"); if(Date.parse(approval.expiresAt)<=Date.now()){ this.database.updateApproval(approval.id,"PENDING","EXPIRED"); throw new Error("APPROVAL_EXPIRED"); }
    if(approval.amountCents!==undefined && approval.amountCents>this.requireCase(row.case_id).brief!.authority.maximumAuthorizedCostCents) throw new Error("MONETARY_CAP_EXCEEDED");
    const nextStatus=replacement?"REPLACED":"APPROVED"; if(!this.database.updateApproval(approval.id,"PENDING",nextStatus)) return this.snapshot(callId);
    const runtime=this.runtime(callId); this.database.updateCall(callId,{generation:row.generation+1});
    if(replacement){ this.assertSafeExactText(row.case_id,replacement); this.addTurn(callId,"USER_EXACT",replacement); await runtime.adapter.speak(callId,replacement,{interruptible:true}); }
    else if(approval.disclosureCardId && approval.executionChannel){
      const entry=this.disclosures.resolve(row.case_id,approval.disclosureCardId,approval.executionChannel); if(!entry) throw new Error("DISCLOSURE_NOT_AVAILABLE");
      const marker=`[REDACTED:${entry.metadata.category}:${entry.metadata.label}]`;
      if(approval.executionChannel==="DTMF"){ if(!validateDtmf(entry.value,true)) throw new Error("INVALID_SENSITIVE_DTMF"); await runtime.adapter.sendDigits(callId,entry.value); this.addTurn(callId,"SYSTEM",`Sent approved ${entry.metadata.label} by DTMF: ${marker}`); }
      else { await runtime.adapter.speak(callId,entry.value,{interruptible:true}); this.addTurn(callId,"LIAISON",`Provided approved ${entry.metadata.label}: ${marker}`); }
      runtime.disclosureLedger.push({label:entry.metadata.label,marker,channel:approval.executionChannel,timestamp:new Date().toISOString()}); this.record(callId,row.case_id,"APPROVAL_APPROVED",{approvalId,label:entry.metadata.label,channel:approval.executionChannel},"USER");
    } else { this.addTurn(callId,"LIAISON",approval.proposedSpeech); await runtime.adapter.speak(callId,approval.proposedSpeech,{interruptible:true}); this.record(callId,row.case_id,"APPROVAL_APPROVED",{approvalId},"USER"); }
    this.changeState(callId,approval.category==="PERSONAL_DATA"?"AUTHENTICATING":"NEGOTIATING","Listening","Continue the approved support strategy"); this.emit(callId,"approval.resolved",{id:approvalId,status:nextStatus}); if(runtime.scenario) this.scheduleNext(callId); return this.snapshot(callId);
  }

  async reject(callId:string,approvalId:string,instruction?:string):Promise<CallSnapshot>{
    const row=this.requireCall(callId); const approval=this.database.getPendingApproval(callId); if(!approval){ return this.snapshot(callId); } if(approval.id!==approvalId) throw new Error("STALE_APPROVAL");
    if(!this.database.updateApproval(approval.id,"PENDING","REJECTED")) return this.snapshot(callId); this.record(callId,row.case_id,"APPROVAL_REJECTED",{approvalId,instruction:instruction?.slice(0,500)},"USER");
    const response=instruction?.trim()||"The account holder does not approve that. Please continue with the original requested outcome."; this.assertSafeExactText(row.case_id,response); this.addTurn(callId,"USER_EXACT",response); await this.runtime(callId).adapter.speak(callId,response,{interruptible:true});
    this.changeState(callId,"NEGOTIATING","Listening","Continue toward the original outcome"); this.emit(callId,"approval.resolved",{id:approvalId,status:"REJECTED"});
    if(this.runtime(callId).scenario?.id==="cancellation-offer"){ this.addTurn(callId,"REMOTE","I have completed the cancellation. Confirmation C-620."); await this.terminalize(callId,"RESOLVED",undefined,"RESOLVED"); }
    else if(this.runtime(callId).scenario) this.scheduleNext(callId); return this.snapshot(callId);
  }

  async pause(callId:string):Promise<CallSnapshot>{ const row=this.requireActiveCall(callId); this.database.updateCall(callId,{paused:true,generation:row.generation+1,activity:"Paused — transcript still active"}); await this.runtime(callId).adapter.pauseAgent(callId); this.record(callId,row.case_id,"AGENT_PAUSED",{},"USER"); this.emit(callId,"call.activity",{activity:"Paused — transcript still active"}); return this.snapshot(callId); }
  async resume(callId:string):Promise<CallSnapshot>{ const row=this.requireActiveCall(callId); const runtime=this.runtime(callId); this.database.updateCall(callId,{paused:false,generation:row.generation+1,activity:"Listening"}); await runtime.adapter.resumeAgent(callId); this.record(callId,row.case_id,"AGENT_RESUMED",{},"USER"); const pending=runtime.pendingRemote.splice(0); if(pending.length){ for(const item of pending){ if(this.database.getPendingApproval(callId)||this.isTerminal(this.requireCall(callId).state)||this.requireCall(callId).paused) break; await this.processRemoteDecision(callId,item.text,item.step); } } else if(runtime.scenario) this.scheduleNext(callId); return this.snapshot(callId); }
  privateInstruction(callId:string,text:string):CallSnapshot{ const row=this.requireActiveCall(callId); const safe=text.trim().slice(0,1000); this.assertSafeExactText(row.case_id,safe); this.runtime(callId).privateInstruction=safe; this.record(callId,row.case_id,"PRIVATE_INSTRUCTION_ADDED",{instruction:safe},"USER"); return this.snapshot(callId); }
  async exactText(callId:string,text:string):Promise<CallSnapshot>{ const row=this.requireActiveCall(callId); const safe=text.trim().slice(0,400); this.assertSafeExactText(row.case_id,safe); this.runtime(callId).executedKeys.add(`USER_EXACT:${randomUUID()}`); this.addTurn(callId,"USER_EXACT",safe); await this.runtime(callId).adapter.speak(callId,safe,{interruptible:true}); this.record(callId,row.case_id,"USER_EXACT_TEXT_SENT",{text:safe},"USER"); return this.snapshot(callId); }
  async hangup(callId:string):Promise<CallSnapshot>{ const row=this.requireCall(callId); this.record(callId,row.case_id,"CALL_END_REQUESTED",{reason:"USER_REQUESTED"},"USER"); await this.terminalize(callId,"USER_REQUESTED",undefined,"UNRESOLVED"); return this.snapshot(callId); }

  async relayMessage(callId:string,message:unknown):Promise<void>{
    if(!message||typeof message!=="object") throw new Error("MALFORMED_RELAY_MESSAGE"); const msg=message as Record<string,unknown>; const row=this.requireCall(callId);
    if(msg.type==="setup"){
      if(msg.accountSid!==this.config.TWILIO_ACCOUNT_SID || msg.callSid!==row.twilio_call_sid) throw new Error("RELAY_CALL_IDENTITY_MISMATCH");
      if(row.state==="DIALING") this.changeState(callId,"CONNECTED","Connected","Navigate the support line"); this.record(callId,row.case_id,"CALL_CONNECTED",{providerCallId:row.twilio_call_sid},"TWILIO"); return;
    }
    if(msg.type==="prompt" && msg.last===true && typeof msg.voicePrompt==="string"){ await this.ingestRemote(callId,msg.voicePrompt); return; }
    if(msg.type==="dtmf" && typeof msg.digit==="string"){ this.addTurn(callId,"SYSTEM",`Remote DTMF received: ${msg.digit}`); return; }
    if(msg.type==="interrupt"){ this.database.updateCall(callId,{generation:row.generation+1,activity:"Interrupted — listening"}); this.record(callId,row.case_id,"AGENT_SPEECH_INTERRUPTED",{durationUntilInterruptMs:msg.durationUntilInterruptMs},"TWILIO"); return; }
    if(msg.type==="error"){ this.record(callId,row.case_id,"TECHNICAL_ERROR",{code:"CONVERSATION_RELAY_ERROR"},"TWILIO"); await this.terminalize(callId,"TECHNICAL_FAILURE","ConversationRelay reported an error"); }
  }
  attachRelaySocket(callId:string,socket:WebSocket):void { this.requireActiveCall(callId); this.twilioAdapter.attachSocket(callId,socket); }
  async twilioStatus(callId:string,status:string):Promise<void>{
    const row=this.requireCall(callId); if(status==="answered"&&row.state==="DIALING") this.changeState(callId,"CONNECTED","Connected","Navigate the support line");
    if(["busy","failed","no-answer","canceled"].includes(status)&&!this.isTerminal(row.state)) await this.terminalize(callId,"TECHNICAL_FAILURE",`Twilio call status: ${status}`,"TECHNICAL_FAILURE");
    if(status==="completed"&&!this.isTerminal(row.state)&&row.state!=="ENDING") await this.terminalize(callId,"UNRESOLVED","Remote call completed","UNRESOLVED");
  }
  async conversationEnded(callId:string,sessionStatus?:string):Promise<void>{ const row=this.requireCall(callId); if(!this.isTerminal(row.state)&&row.state!=="ENDING") await this.terminalize(callId,sessionStatus==="failed"?"TECHNICAL_FAILURE":"UNRESOLVED",`ConversationRelay session: ${sessionStatus??"ended"}`,sessionStatus==="failed"?"TECHNICAL_FAILURE":"UNRESOLVED"); }
  async relayClosed(callId:string):Promise<void>{ const row=this.database.getCall(callId); if(row&&!this.isTerminal(row.state)) await this.terminalize(callId,"TECHNICAL_FAILURE","ConversationRelay WebSocket closed unexpectedly","DISCONNECTED"); }

  snapshot(callId:string):CallSnapshot{
    const row=this.requireCall(callId); const runtime=this.runtimes.get(callId); return {id:row.id,caseId:row.case_id,mode:row.mode,scenarioId:row.scenario_id,state:row.state,activity:row.activity,currentObjective:row.objective,paused:Boolean(row.paused),humanDetected:Boolean(row.human_detected),disclosureDelivered:Boolean(row.disclosure_delivered),consentStatus:row.consent_status,startedAt:row.started_at,endedAt:row.ended_at,durationSeconds:row.duration_seconds,estimatedCostUsd:row.estimated_cost_usd,generation:row.generation,llmInputTokens:row.llm_input_tokens,llmOutputTokens:row.llm_output_tokens,transcript:this.database.getTranscript(callId),pendingApproval:this.database.getPendingApproval(callId),outcome:this.database.getOutcome(callId),disclosureLedger:runtime?.disclosureLedger??[]};
  }
  storedEvents(callId:string,after:number){ return this.database.listEvents(callId,after); }
  onCallEvent(callId:string,listener:(event:BrowserEvent)=>void):()=>void { const key=`call:${callId}`; this.events.on(key,listener); return()=>this.events.off(key,listener); }
  async shutdown():Promise<void>{ const active=this.database.getActiveCall(); if(active)await this.terminalize(active.id,"TECHNICAL_FAILURE","Server shutdown ended the active call","TECHNICAL_FAILURE"); this.disclosures.clearAll(); }

  private async terminalize(callId:string,reason:EndReason,technical?:string,statusOverride?:string):Promise<void>{
    const row=this.requireCall(callId); if(this.isTerminal(row.state)) return; const runtime=this.runtime(callId); if(runtime.terminalizing) return; runtime.terminalizing=true; clearTimeout(runtime.timer); clearInterval(runtime.durationTimer);
    this.database.updateCall(callId,{generation:row.generation+1}); const pending=this.database.getPendingApproval(callId); if(pending) this.database.updateApproval(pending.id,"PENDING","EXPIRED");
    try { if(row.state!=="ENDING") this.changeState(callId,"ENDING","Ending","Complete the call safely"); await runtime.adapter.endCall(callId,reason); } catch(error){ this.record(callId,row.case_id,"TECHNICAL_ERROR",{code:this.safeError(error)},"TELEPHONY"); }
    const latest=this.requireCall(callId); const duration=Math.max(latest.duration_seconds,Math.floor((Date.now()-Date.parse(latest.started_at))/1000)); const finalState=reason==="TECHNICAL_FAILURE"?"FAILED":"COMPLETED";
    this.database.updateCall(callId,{state:finalState,activity:finalState==="COMPLETED"?"Completed":"Failed",objective:"Review the outcome",endedAt:new Date().toISOString(),durationSeconds:duration,estimatedCostUsd:estimateCost(duration,this.config.ESTIMATED_TELEPHONY_COST_PER_MINUTE_USD),terminalReason:technical??reason});
    this.database.db.prepare("UPDATE cases SET status=?, updated_at=? WHERE id=?").run(finalState,new Date().toISOString(),row.case_id); this.record(callId,row.case_id,"CALL_ENDED",{reason,status:statusOverride??this.statusForReason(reason)},"SYSTEM");
    await this.compileOutcome(callId,statusOverride??this.statusForReason(reason)); this.disclosures.clearCase(row.case_id); this.emit(callId,"outcome.ready",{callId}); runtime.terminalizing=false;
  }

  private async compileOutcome(callId:string,statusRaw:string):Promise<void>{
    if(this.database.getOutcome(callId)) return; const row=this.requireCall(callId); const transcript=this.database.getTranscript(callId); const item=this.requireCase(row.case_id);
    const remote=transcript.filter((turn)=>turn.speaker==="REMOTE"); const last=remote.at(-1); const first=remote.find((turn)=>/my name is|this is/i.test(turn.text)); const caseMatch=last?.text.match(/(?:case|confirmation)(?: number)?\s+(?:is\s+)?([A-Z]-?\d+)/i); const repMatch=first?.text.match(/(?:my name is|this is)\s+([A-Z][a-z]+)/);
    const ev=last?[{turnId:last.id,exactQuote:last.text}]:[]; const grounded=<T>(value:T)=>last?{value,evidence:ev}:null; const status=this.normalizeOutcomeStatus(statusRaw);
    const fallback:OutcomeReport={status,summary:grounded(status==="RESOLVED"?"The representative confirmed a concrete support outcome.":"The call ended without a fully verified resolution."),representativeName:repMatch&&first?{value:repMatch[1],evidence:[{turnId:first.id,exactQuote:repMatch[0]}]}:null,department:null,caseNumber:caseMatch&&last?{value:caseMatch[1],evidence:[{turnId:last.id,exactQuote:caseMatch[0]}]}:null,resolution:status==="RESOLVED"&&last?{value:last.text,evidence:ev}:null,monetaryOutcomes:[],companyCommitments:status==="RESOLVED"&&last?[{value:last.text,evidence:ev}]:[],userActions:[],deadlines:last&&/business days|today|within/i.test(last.text)?[{value:last.text,evidence:ev}]:[],unresolvedItems:status!=="RESOLVED"&&last?[{value:last.text,evidence:ev}]:[],endedAt:row.ended_at??new Date().toISOString(),durationSeconds:row.duration_seconds,estimatedTelephonyCostUsd:row.estimated_cost_usd,llmUsage:{inputTokens:row.llm_input_tokens,outputTokens:row.llm_output_tokens,totalTokens:row.llm_input_tokens+row.llm_output_tokens}};
    let report=fallback; try{ report=await this.models.outcome({brief:item.brief!,transcript,deterministicFallback:fallback}); }catch(error){ this.record(callId,row.case_id,"TECHNICAL_ERROR",{code:`OUTCOME_MODEL:${this.safeError(error)}`},"MODEL"); }finally{this.flushModelTelemetry(callId,row.case_id);}
    const usageRow=this.requireCall(callId); report={...report,llmUsage:{inputTokens:usageRow.llm_input_tokens,outputTokens:usageRow.llm_output_tokens,totalTokens:usageRow.llm_input_tokens+usageRow.llm_output_tokens}};
    report=validateOutcome(report,transcript); this.database.saveOutcome(callId,report); this.record(callId,row.case_id,"OUTCOME_GENERATED",{status:report.status},this.config.LLM_MODE.toUpperCase());
  }

  exportJson(callId:string):OutcomeReport{ const report=this.database.getOutcome(callId); if(!report) throw new Error("OUTCOME_NOT_READY"); return report; }
  exportText(callId:string):string{ const report=this.exportJson(callId); const value=(field:{value:unknown}|null)=>field?String(field.value):"Not established"; return [`Liaison call outcome`,`Status: ${report.status}`,`Summary: ${value(report.summary)}`,`Representative: ${value(report.representativeName)}`,`Department: ${value(report.department)}`,`Case number: ${value(report.caseNumber)}`,`Resolution: ${value(report.resolution)}`,`Duration: ${report.durationSeconds} seconds`,`Estimated telephony cost: $${report.estimatedTelephonyCostUsd.toFixed(4)}`,`LLM tokens: ${report.llmUsage?.totalTokens??0} total (${report.llmUsage?.inputTokens??0} input, ${report.llmUsage?.outputTokens??0} output)`,`Unresolved items: ${report.unresolvedItems.map((item)=>item.value).join("; ")||"None recorded"}`,`Generated from transcript evidence; cost is an estimate, not an invoice.`].join("\n"); }

  private addTurn(callId:string,speaker:TranscriptTurn["speaker"],text:string):TranscriptTurn{
    const row=this.requireCall(callId); const safe=redactText(text,this.disclosures.redactionInputs(row.case_id)); const existing=this.database.getTranscript(callId); const turn:TranscriptTurn={id:randomUUID(),sequence:existing.length+1,speaker,text:safe,timestamp:new Date().toISOString()}; this.database.addTranscript(callId,turn);
    const event:EventType=speaker==="REMOTE"?"REMOTE_TRANSCRIPT_FINAL":speaker==="USER_EXACT"?"USER_EXACT_TEXT_SENT":speaker==="LIAISON"?"AGENT_SPEECH_STARTED":"CALL_STATE_CHANGED"; this.record(callId,row.case_id,event,{turn},speaker); this.emit(callId,"transcript.turn",turn); return turn;
  }
  private changeState(callId:string,next:CallState,activity:string,objective:string):void{ const row=this.requireCall(callId); if(row.state!==next) transitionState(row.state,next); this.database.updateCall(callId,{state:next,activity,objective}); this.record(callId,row.case_id,"CALL_STATE_CHANGED",{from:row.state,to:next,activity,objective},"SYSTEM"); this.emit(callId,"call.state",{state:next,activity,objective}); }
  private record(callId:string|undefined,caseId:string|undefined,type:EventType,payload:unknown,origin:string):number{ const secrets=caseId?this.disclosures.redactionInputs(caseId):[]; const clean=sanitizePayload(payload,secrets); const sequence=this.database.appendEvent({id:randomUUID(),callId,caseId,type,payload:clean,origin}); if(callId) this.emit(callId,this.browserType(type),clean,sequence); return sequence; }
  private emit(callId:string,type:string,data:unknown,id?:number):void{ const runtime=this.runtimes.get(callId); const sequence=id??(runtime?++runtime.browserSequence:Date.now()); if(runtime) runtime.browserSequence=Math.max(runtime.browserSequence,sequence); this.events.emit(`call:${callId}`,{id:sequence,type,data} satisfies BrowserEvent); }
  private browserType(type:EventType):string{ if(type==="APPROVAL_REQUESTED")return"approval.requested"; if(type==="CALL_ENDED")return"call.status"; if(type==="OUTCOME_GENERATED")return"outcome.ready"; if(type==="TECHNICAL_ERROR")return"error"; return"audit.event"; }
  private flushModelTelemetry(callId:string|undefined,caseId:string):void{ for(const item of this.models.drainTelemetry())this.captureModelTelemetry(callId,caseId,item); }
  private captureModelTelemetry(callId:string|undefined,caseId:string,item:ModelTelemetry):void{ if(callId)this.database.addModelUsage(callId,item.inputTokens,item.outputTokens); this.record(callId,caseId,"MODEL_RESPONSE_RECEIVED",{modelOperation:item.operation,requestId:item.requestId,responseId:item.responseId,inputTokens:item.inputTokens,outputTokens:item.outputTokens,totalTokens:item.totalTokens},"MODEL"); }
  private assertSafeExactText(caseId:string,text:string):void{ if(!text) throw new Error("TEXT_REQUIRED"); const reason=prohibitedSecretReason(text); if(reason) throw new Error(`PROHIBITED_SECRET:${reason}`); if(redactText(text,this.disclosures.redactionInputs(caseId))!==text) throw new Error("USE_APPROVED_DISCLOSURE_CARD"); }
  private requireCase(id:string):CaseDetail{ const item=this.database.getCase(id); if(!item) throw new Error("CASE_NOT_FOUND"); return item; }
  private requireApprovedCase(id:string):CaseDetail{ const item=this.requireCase(id); if(!item.brief||item.approvedVersion!==item.brief.version) throw new Error("APPROVED_PLAN_REQUIRED"); return item; }
  private requireCall(id:string):StoredCall{ const row=this.database.getCall(id); if(!row) throw new Error("CALL_NOT_FOUND"); return row; }
  private requireActiveCall(id:string):StoredCall{ const row=this.requireCall(id); if(this.isTerminal(row.state)) throw new Error("CALL_ALREADY_ENDED"); return row; }
  private runtime(id:string):Runtime{ const value=this.runtimes.get(id); if(!value) throw new Error("CALL_RUNTIME_NOT_AVAILABLE"); return value; }
  private isTerminal(state:CallState){ return state==="COMPLETED"||state==="FAILED"; }
  private objectiveFor(state:CallState){ const map:Partial<Record<CallState,string>>={IVR:"Navigate the support menu",DISCLOSING_ASSISTANT:"Obtain consent to continue",EXPLAINING_ISSUE:"Explain the approved issue",AUTHENTICATING:"Use an approved authentication method",NEGOTIATING:"Seek the requested outcome",VERIFYING_OUTCOME:"Confirm concrete details"}; return map[state]??"Continue the supervised call"; }
  private reasonForStatus(status:string):EndReason{ const map:Record<string,EndReason>={RESOLVED:"RESOLVED",PARTIAL:"PARTIALLY_RESOLVED",UNRESOLVED:"UNRESOLVED",REFUSED_AUTOMATION:"REPRESENTATIVE_REFUSED_AUTOMATION",AUTHENTICATION_REQUIRED:"AUTHENTICATION_REQUIRED",DISCONNECTED:"TECHNICAL_FAILURE",TECHNICAL_FAILURE:"TECHNICAL_FAILURE"}; return map[status]??"UNRESOLVED"; }
  private proposedForStatus(status:string):"RESOLVED"|"PARTIAL"|"UNRESOLVED"|"REFUSED_AUTOMATION"|"AUTHENTICATION_REQUIRED"|"TECHNICAL_FAILURE"{ return status==="DISCONNECTED"?"TECHNICAL_FAILURE":status as ReturnType<CallService["proposedForStatus"]>; }
  private statusForReason(reason:EndReason):string{ const map:Record<EndReason,string>={RESOLVED:"RESOLVED",PARTIALLY_RESOLVED:"PARTIAL",UNRESOLVED:"UNRESOLVED",REPRESENTATIVE_REFUSED_AUTOMATION:"REFUSED_AUTOMATION",AUTHENTICATION_REQUIRED:"AUTHENTICATION_REQUIRED",USER_REQUESTED:"UNRESOLVED",TECHNICAL_FAILURE:"TECHNICAL_FAILURE",POLICY_BLOCKED:"UNRESOLVED"}; return map[reason]; }
  private normalizeOutcomeStatus(status:string):OutcomeReport["status"]{ return (["RESOLVED","PARTIAL","UNRESOLVED","REFUSED_AUTOMATION","AUTHENTICATION_REQUIRED","DISCONNECTED","TECHNICAL_FAILURE"] as const).includes(status as OutcomeReport["status"])?status as OutcomeReport["status"]:"UNRESOLVED"; }
  private safeError(error:unknown):string{ return error instanceof Error?error.message.replace(/[A-Za-z0-9_-]{24,}/g,"[FILTERED]").slice(0,300):"UNKNOWN_ERROR"; }
}
