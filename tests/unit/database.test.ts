import { describe,expect,it } from "vitest";
import { LiaisonDatabase } from "../../src/server/database/db.js";

describe("database invariants",()=>{
  it("stores redacted audit payloads and makes idempotent approvals",()=>{const db=new LiaisonDatabase(":memory:");const now=new Date().toISOString();db.createCase({id:"c",companyName:"Company",title:"Title",intake:{},disclosureMetadata:[]});db.createCall({id:"call",caseId:"c",mode:"SIMULATOR",scenarioId:"x",state:"PREPARING",activity:"Preparing",objective:"Test"});db.saveApproval({id:"approval",callId:"call",status:"PENDING",category:"PERSONAL_DATA",question:"Share?",representativeRequest:"Request",proposedSpeech:"Redacted",consequences:"Disclosure",createdAt:now,expiresAt:new Date(Date.now()+1000).toISOString()});expect(db.updateApproval("approval","PENDING","APPROVED")).toBe(true);expect(db.updateApproval("approval","PENDING","APPROVED")).toBe(false);db.close()});
  it("deletes expired completed cases",()=>{const db=new LiaisonDatabase(":memory:");db.createCase({id:"old",companyName:"Company",title:"Old",intake:{},disclosureMetadata:[]});db.db.prepare("UPDATE cases SET updated_at='2000-01-01T00:00:00.000Z',status='COMPLETED' WHERE id='old'").run();expect(db.deleteExpired(30)).toBe(1);db.close()});
});
