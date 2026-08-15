import { describe,expect,it } from "vitest";
import { DisclosureStore } from "../../src/server/security/disclosures.js";

describe("ephemeral disclosures",()=>{
  it("keeps values out of metadata and honors channels and requested category",()=>{const store=new DisclosureStore();const metadata=store.createForCase("case",[{label:"Account number",category:"ACCOUNT_NUMBER",permission:"ASK",allowedChannels:["DTMF"],allowedPurposes:["Account authentication"],value:"AC-2048"}]);expect(JSON.stringify(metadata)).not.toContain("AC-2048");expect(store.resolve("case",metadata[0].id,"SPEECH","provide the account number for authentication")).toBeNull();expect(store.resolve("case",metadata[0].id,"DTMF","accept a retention offer")).toBeNull();expect(store.resolve("case",metadata[0].id,"DTMF","provide the account number for authentication")?.value).toBe("AC-2048");store.clearCase("case");expect(store.resolve("case",metadata[0].id,"DTMF","provide the account number for authentication")).toBeNull()});

  it("releases a value only when the request names that card's own category",()=>{
    const store=new DisclosureStore();
    const [account,order]=store.createForCase("case",[
      {label:"Account number",category:"ACCOUNT_NUMBER",permission:"ASK",allowedChannels:["SPEECH"],allowedPurposes:["Account-number identification or authentication"],value:"AC-2048"},
      {label:"Order number",category:"ORDER_NUMBER",permission:"ASK",allowedChannels:["SPEECH"],allowedPurposes:["Order-number identification or lookup"],value:"ORDER-77"},
    ]);
    // Both stored policies contain the word "identification"; that must not make them interchangeable.
    expect(store.resolve("case",account.id,"SPEECH","I need the order number to look this up")).toBeNull();
    expect(store.resolve("case",order.id,"SPEECH","can you authenticate the account")).toBeNull();
    expect(store.resolve("case",account.id,"SPEECH","can you authenticate the account")?.value).toBe("AC-2048");
    expect(store.resolve("case",order.id,"SPEECH","I need the order number to look this up")?.value).toBe("ORDER-77");
    // Unrecognised requests fail closed rather than matching on incidental shared vocabulary.
    for(const vague of ["for identification purposes","I just need to verify something","please confirm"])
      for(const card of [account,order]) expect(store.resolve("case",card.id,"SPEECH",vague)).toBeNull();
  });
  it("adds and removes a value without replacing existing volatile cards",()=>{const store=new DisclosureStore();const [first]=store.createForCase("case",[{label:"Account number",category:"ACCOUNT_NUMBER",permission:"ASK",allowedChannels:["SPEECH"],allowedPurposes:["Account authentication"],value:"AC-2048"}]);const second=store.addForCase("case",{label:"Order number",category:"ORDER_NUMBER",permission:"ASK",allowedChannels:["SPEECH"],allowedPurposes:["Order lookup"],value:"ORDER-77"});expect(store.metadata("case").map((item)=>item.id)).toEqual([first.id,second.id]);expect(JSON.stringify(store.metadata("case"))).not.toContain("ORDER-77");store.remove("case",second.id);expect(store.resolve("case",second.id,"SPEECH","order lookup")).toBeNull();expect(store.resolve("case",first.id,"SPEECH","account authentication")?.value).toBe("AC-2048")});
  it("rejects prohibited credentials",()=>{const store=new DisclosureStore();expect(()=>store.createForCase("case",[{label:"Password",category:"OTHER_ALLOWED",permission:"ASK",allowedChannels:["SPEECH"],allowedPurposes:["Login"],value:"hunter2"}])).toThrow("PROHIBITED_DISCLOSURE")});
});
