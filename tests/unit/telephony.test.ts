import { describe,expect,it,vi } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import { TwilioConversationRelayAdapter } from "../../src/server/telephony/adapters.js";

describe("Twilio adapter",()=>{
  it("creates and terminates a real outbound Calls API resource through the SDK boundary",async()=>{
    const config=loadConfig({NODE_ENV:"test",PUBLIC_BASE_URL:"https://liaison.example",PUBLIC_WSS_URL:"wss://liaison.example",TELEPHONY_MODE:"twilio",ALLOW_REAL_CALLS:"true",TWILIO_ACCOUNT_SID:"ACtest",TWILIO_AUTH_TOKEN:"auth-token",TWILIO_FROM_NUMBER:"+12125550199",SESSION_SECRET:"session",CALL_TOKEN_SECRET:"call"});
    const adapter=new TwilioConversationRelayAdapter(config);const update=vi.fn().mockResolvedValue({sid:"CA123"});const callResource=vi.fn(()=>({update}));const create=vi.fn().mockResolvedValue({sid:"CA123"});Object.assign(callResource,{create});
    (adapter as unknown as {client:{calls:typeof callResource}}).client={calls:callResource};
    const result=await adapter.startCall({callId:"call-1",destination:"+12125550198",signedToken:"opaque.token"});
    expect(result.providerCallId).toBe("CA123");expect(create).toHaveBeenCalledWith(expect.objectContaining({to:"+12125550198",from:"+12125550199",record:false,url:"https://liaison.example/webhooks/twilio/voice/opaque.token",statusCallbackEvent:["initiated","ringing","answered","completed"]}));
    await adapter.endCall("call-1","USER_REQUESTED");expect(callResource).toHaveBeenCalledWith("CA123");expect(update).toHaveBeenCalledWith({status:"completed"});
    await adapter.endOrphanedCall("CA-orphan");expect(callResource).toHaveBeenCalledWith("CA-orphan");
  });
});
