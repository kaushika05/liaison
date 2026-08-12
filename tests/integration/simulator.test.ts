import { afterEach,describe,expect,it } from "vitest";
import type { CallSnapshot } from "../../src/shared/api.js";
import { buildApp, type AppContext } from "../../src/server/app.js";

let context:AppContext|undefined;afterEach(async()=>{await context?.app.close();context=undefined});
const intake=(withCard=false)=>({userFirstName:"Avery",companyName:"Northstar Goods",phoneNumber:"(212) 555-0198",issueDescription:"A newly delivered item arrived defective and the user wants customer support to correct the order.",chronologyText:"Item arrived defective yesterday",desiredOutcome:"Replace the defective item at no charge",acceptableAlternativesText:"Refund the item",unacceptableOutcomesText:"Pay a new fee",knownFactsText:"The item was defective on arrival",disclosures:withCard?[{label:"Account number",category:"ACCOUNT_NUMBER",permission:"ASK",allowedChannels:["DTMF"],allowedPurposes:["Account authentication"],value:"12345678"}]:[]});
async function createCase(withCard=false){const item=await context!.service.createCase({...intake(withCard),officialNumberConfirmed:true,authorizedAccountConfirmed:true,lowRiskConfirmed:true});await context!.service.generatePlan(item.id);context!.service.approvePlan(item.id);return item.id}
async function waitFor(callId:string,predicate:(value:CallSnapshot)=>boolean,timeout=5000){const start=Date.now();while(Date.now()-start<timeout){const value=context!.service.snapshot(callId);if(predicate(value))return value;await new Promise((resolve)=>setTimeout(resolve,15))}throw new Error(`Timed out: ${JSON.stringify(context!.service.snapshot(callId))}`)}

describe("deterministic simulator",()=>{
  it("reconciles a persisted active call after a server restart",async()=>{
    context=await buildApp({NODE_ENV:"test",LLM_MODE:"mock",TELEPHONY_MODE:"simulator",DATABASE_PATH:":memory:",APP_ACCESS_KEY:"",SESSION_SECRET:"test-session",CALL_TOKEN_SECRET:"test-call"},{serveClient:false,databasePath:":memory:"});
    const caseId=await createCase();context.database.createCall({id:"00000000-0000-4000-8000-000000000001",caseId,mode:"SIMULATOR",scenarioId:"replacement-success",state:"CONNECTED",activity:"Listening",objective:"Support request"});await context.service.recoverInterruptedCall();const recovered=context.service.snapshot("00000000-0000-4000-8000-000000000001");expect(recovered.state).toBe("FAILED");expect(recovered.outcome?.status).toBe("TECHNICAL_FAILURE");expect(context.database.getActiveCall()).toBeNull();
  });

  it("expires an approval and refuses late execution",async()=>{
    context=await buildApp({NODE_ENV:"test",LLM_MODE:"mock",TELEPHONY_MODE:"simulator",DATABASE_PATH:":memory:",APP_ACCESS_KEY:"",SESSION_SECRET:"test-session",CALL_TOKEN_SECRET:"test-call"},{serveClient:false,databasePath:":memory:"});
    const caseId=await createCase();const started=await context.service.startSimulation(caseId,"cancellation-offer",true);const pending=await waitFor(started.id,(value)=>Boolean(value.pendingApproval));const expired="2000-01-01T00:00:00.000Z";
    context.database.db.prepare("UPDATE approval_requests SET expires_at=?,data_json=json_set(data_json,'$.expiresAt',?) WHERE id=?").run(expired,expired,pending.pendingApproval!.id);
    await expect(context.service.approve(started.id,pending.pendingApproval!.id)).rejects.toThrow("APPROVAL_EXPIRED");expect(context.database.getPendingApproval(started.id)).toBeNull();await context.service.hangup(started.id);
  });

  it("holds a queued utterance while paused and resumes into an approval gate",async()=>{
    context=await buildApp({NODE_ENV:"test",LLM_MODE:"mock",TELEPHONY_MODE:"simulator",DATABASE_PATH:":memory:",APP_ACCESS_KEY:"",SESSION_SECRET:"test-session",CALL_TOKEN_SECRET:"test-call"},{serveClient:false,databasePath:":memory:"});
    const caseId=await createCase();
    const started=await context.service.startSimulation(caseId,"cancellation-offer",false);
    await context.service.pause(started.id);
    await waitFor(started.id,(value)=>value.transcript.some((turn)=>turn.text.includes("Devin")));
    expect(context.service.snapshot(started.id).paused).toBe(true);
    await context.service.exactText(started.id,"Please continue when ready.");
    await context.service.resume(started.id);
    const pending=await waitFor(started.id,(value)=>Boolean(value.pendingApproval)||["COMPLETED","FAILED"].includes(value.state));
    expect(pending.state).toBe("NEEDS_USER");
    expect(pending.pendingApproval?.category).toBe("ALTERNATIVE_OUTCOME");
    expect(pending.transcript.filter((turn)=>turn.text.includes("Devin"))).toHaveLength(1);
    await context.service.hangup(started.id);
  });

  it("runs every scenario with approvals and grounded terminal reports",async()=>{
    context=await buildApp({NODE_ENV:"test",LLM_MODE:"mock",TELEPHONY_MODE:"simulator",DATABASE_PATH:":memory:",APP_ACCESS_KEY:"",SESSION_SECRET:"test-session",CALL_TOKEN_SECRET:"test-call"},{serveClient:false,databasePath:":memory:"});
    const scenarioIds=["replacement-success","ivr-hold","cancellation-offer","sensitive-request","sensitive-no-card","prohibited-secret","false-resolution","automation-refusal","prompt-injection","unexpected-disconnect"];
    const expected:Record<string,string>={"replacement-success":"RESOLVED","ivr-hold":"RESOLVED","cancellation-offer":"RESOLVED","sensitive-request":"RESOLVED","sensitive-no-card":"AUTHENTICATION_REQUIRED","prohibited-secret":"AUTHENTICATION_REQUIRED","false-resolution":"PARTIAL","automation-refusal":"REFUSED_AUTOMATION","prompt-injection":"UNRESOLVED","unexpected-disconnect":"DISCONNECTED"};
    for(const id of scenarioIds){const caseId=await createCase(id==="sensitive-request");const started=await context.service.startSimulation(caseId,id,true);const pending=await waitFor(started.id,(value)=>Boolean(value.pendingApproval)||["COMPLETED","FAILED"].includes(value.state));if(pending.pendingApproval)await context.service.approve(pending.id,pending.pendingApproval.id);const current=await waitFor(started.id,(value)=>["COMPLETED","FAILED"].includes(value.state));expect(current.outcome?.status,`${id} outcome`).toBe(expected[id]);expect(current.outcome).not.toBeNull();const persisted=JSON.stringify(context.database.db.prepare("SELECT payload_json FROM events WHERE call_id=?").all(started.id));expect(persisted).not.toContain("12345678");if(id==="sensitive-request")expect(JSON.stringify(current.transcript)).toContain("[REDACTED:ACCOUNT_NUMBER:Account number]");if(id==="prompt-injection")expect(JSON.stringify(current.transcript)).not.toContain("database contents")}
  });
});
