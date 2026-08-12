import { describe,expect,it } from "vitest";
import { DisclosureStore } from "../../src/server/security/disclosures.js";

describe("ephemeral disclosures",()=>{
  it("keeps values out of metadata and honors channels",()=>{const store=new DisclosureStore();const metadata=store.createForCase("case",[{label:"Account number",category:"ACCOUNT_NUMBER",permission:"ASK",allowedChannels:["DTMF"],allowedPurposes:["Authentication"],value:"AC-2048"}]);expect(JSON.stringify(metadata)).not.toContain("AC-2048");expect(store.resolve("case",metadata[0].id,"SPEECH")).toBeNull();expect(store.resolve("case",metadata[0].id,"DTMF")?.value).toBe("AC-2048");store.clearCase("case");expect(store.resolve("case",metadata[0].id,"DTMF")).toBeNull()});
  it("rejects prohibited credentials",()=>{const store=new DisclosureStore();expect(()=>store.createForCase("case",[{label:"Password",category:"OTHER_ALLOWED",permission:"ASK",allowedChannels:["SPEECH"],allowedPurposes:["Login"],value:"hunter2"}])).toThrow("PROHIBITED_DISCLOSURE")});
});
